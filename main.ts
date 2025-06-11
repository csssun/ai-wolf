// main.ts
import { Server } from "socket_io/mod.ts";
import { serveFile } from "$std/http/file_server.ts";
import { load } from "$std/dotenv/mod.ts";
import { cryptoRandomString } from "https://deno.land/x/crypto_random_string@1.1.0/mod.ts";
// 在文件顶部添加，替换之前的 import { shuffle } 语句
function shuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

await load({ export: true });
const kv = await Deno.openKv();
console.log("Deno KV initialized.");

// --- Constants ---
const MIN_PLAYERS = 6; // Adjusted
const MAX_PLAYERS = 12; // Adjusted
const SHORT_DELAY_SEC = 3; // 阶段切换
const ACTION_DURATION_SEC = 15; // 单角色行动时间
const DISCUSSION_DURATION_SEC = 40; // 白天讨论
const VOTING_DURATION_SEC = 20; // 投票
const HUNTER_DURATION_SEC = 12; // 猎人开枪
const REVEAL_DURATION_SEC = 5; // 公布结果

type Role = 'WOLF' | 'VILLAGER' | 'SEER' | 'WITCH' | 'HUNTER' | 'GUARD' | 'CUPID' | 'THIEF' | 'IDIOT';
type Alignment = 'GOOD' | 'WOLF' | 'LOVER';
type Winner = Alignment | 'NONE' | 'DRAW';
type RoomState = 'WAITING' | 'STARTING' | 'NIGHT' | 'DAY' | 'VOTING' | 'OVER' | 'HUNTER_SHOOT' | 'NIGHT_0';
// Actions requiring prompts
type ActionType = 'kill' | 'check' | 'vote' | 'guard' | 'heal' | 'poison' | 'shoot' | 'link_1' | 'link_2' | 'choose_role' | 'skip';
type DeathReason = 'WOLF' | 'VOTE' | 'POISON' | 'LOVER' | 'HUNTER' | 'DISCONNECT';
type QueueMessageType =
  | 'NIGHT_0_START'
  | 'NIGHT_0_THIEF_END'
  | 'NIGHT_0_CUPID_END'
  | 'NIGHT_START' // -> DAY >= 1
  | 'NIGHT_GUARD_END'
  | 'NIGHT_WOLF_END'
  | 'NIGHT_WITCH_HEAL_END'
  | 'NIGHT_WITCH_POISON_END'
  | 'NIGHT_SEER_END'
  | 'DAY_ANNOUNCE' // Calculate all night deaths, check triggers
  | 'DAY_START_DISCUSSION'
  | 'VOTING_START'
  | 'VOTING_END' // Calculate vote, check triggers
  | 'HUNTER_SHOOT_END'
  | 'CHECK_WIN_AND_NEXT' // Central place to check win after any death event
  | 'END_GAME'
  | 'RESET_ROOM';

interface QueueMessage {
  type: QueueMessageType;
  code: string;
  day: number;
  winner?: Winner;
  trigger_sid?: string,
  deaths?: Map<string, DeathReason>
}
interface Target {
  sid: string;
  name: string;
  role?: Role
} // role for thief
interface RoleConfig {
  roles: Role[],
  add_for_thief: number
}

// 角色配置 - 必须与人数匹配。如果含盗贼，列表长度 = 人数+add_for_thief
const ROLE_CONFIG: Record<number, RoleConfig> = {
  6: { roles: ['WOLF', 'WOLF', 'SEER', 'WITCH', 'VILLAGER', 'VILLAGER'], add_for_thief: 0 },
  8: { roles: ['WOLF', 'WOLF', 'SEER', 'WITCH', 'HUNTER', 'GUARD', 'VILLAGER', 'VILLAGER'], add_for_thief: 0 },
  // 10人 + 盗贼 + 丘比特 (10 players, 12 roles total for thief)
  10: { roles: ['THIEF', 'CUPID', 'WOLF', 'WOLF', 'WOLF', 'SEER', 'WITCH', 'HUNTER', 'GUARD', 'IDIOT', 'VILLAGER', 'VILLAGER'], add_for_thief: 2 },
  12: { roles: ['THIEF', 'CUPID', 'WOLF', 'WOLF', 'WOLF', 'WOLF', 'SEER', 'WITCH', 'HUNTER', 'GUARD', 'IDIOT', 'VILLAGER', 'VILLAGER', 'VILLAGER'], add_for_thief: 2 },
};
// 定义夜晚行动顺序
const NIGHT_SEQUENCE: readonly Role[] = ['GUARD', 'WOLF', 'WITCH', 'SEER'];

const ROLE_NAME: Record<Role, string> = {
  WOLF: "狼人",
  VILLAGER: "平民",
  SEER: "预言家",
  WITCH: "女巫",
  HUNTER: "猎人",
  GUARD: "守卫",
  CUPID: "丘比特",
  THIEF: "盗贼",
  IDIOT: "白痴"
};
const getAlignment = (role: Role | null): Alignment => {
  if (!role) return 'GOOD';
  if (role === 'WOLF') return 'WOLF';
  return 'GOOD'; // All others default to GOOD unless linked
}
const ROLE_DESC: Record<Role, string> = {
  WOLF: "夜晚猎杀。胜利目标：屠边。",
  VILLAGER: "无特殊能力。白天投票放逐狼人。",
  SEER: "每晚查验一名玩家阵营。",
  WITCH: "拥有一瓶解药和一瓶毒药。解药可救活被狼人杀害的玩家，毒药可毒死一名玩家。每晚最多使用一瓶药。",
  HUNTER: "被狼人杀死或被投票出局时，可以开枪带走一名玩家（被毒/殉情无法开枪）。",
  GUARD: "每晚守护一名玩家免于狼人袭击，不能连续两晚守护同一人。",
  CUPID: "游戏开始时连接两名玩家成为情侣。情侣之一死亡，另一方殉情。情侣可能形成第三方阵营。",
  THIEF: "游戏开始时在两张额外牌中选择一张作为身份。若有狼人牌，则必须选狼人。",
  IDIOT: "被投票出局时，翻牌亮明身份可免死，但失去投票权。",
};
const STATE_NAME: Record<RoomState, string> = {
  WAITING: "等待中",
  STARTING: "即将开始",
  NIGHT_0: "初始设置",
  NIGHT: "黑夜",
  DAY: "白天",
  VOTING: "投票中",
  HUNTER_SHOOT: "猎人时刻",
  OVER: "已结束"
};

// --- Type Definitions ---
type Player = {
  username: string;
  role: Role | null;
  original_role: Role | null; // For lovers/thief
  alive: boolean;
  sid: string;
  isBot: boolean;
  // Actions
  target_sid: string | null; // All night actions, hunter shoot
  voted_for: string | null; // Day vote
  cupid_first_lover: string | null; // For cupid bot tracking
  // States
  is_lover: boolean;
  idiot_revealed: boolean;
};
interface Room {
  name: string;
  code: string;
  password?: string;
  host_sid: string;
  state: RoomState;
  min_players: number;
  max_players: number;
  player_count: number;
  day: number;
  winner: Winner | null;
  // Role states
  witch_has_heal: boolean;
  witch_has_poison: boolean;
  guard_last_protect_sid: string | null;
  lovers_sids: string[]; // Pair
  thief_choices: Role[]; // Night 0 only
  // Night calculation buffer
  night_wolf_kill_sid: string | null;
  night_guarded_sid: string | null;
  night_healed: boolean; // witch used heal
  night_poisoned_sid: string | null;
}
interface RoomInfo {
  code: string;
  name: string;
  players: number;
  max_players: number;
  has_password: boolean;
  state: RoomState;
}

// --- KV Key Helpers & Data Access (Same as before, omitted for brevity) ---
const getRoomKey = (code: string) => ["rooms", code];
const getPlayerKey = (code: string, sid: string) => ["players", code, sid];
const getPlayerRoomKey = (sid: string) => ["player_room", sid];
const getRoomListInfoKey = (code: string) => ["room_list_info", code];
const getRoom = async (code: string): Promise<Room | null> => (await kv.get<Room>(getRoomKey(code))).value;
const getRoomEntry = async (code: string): Promise<Deno.KvEntryMaybe<Room>> => await kv.get<Room>(getRoomKey(code));
const getPlayer = async (code: string, sid: string): Promise<Player | null> => (await kv.get<Player>(getPlayerKey(code, sid))).value;
const getPlayerRoomCode = async (sid: string): Promise<string | null> => (await kv.get<string>(getPlayerRoomKey(sid))).value;

async function getPlayersInRoom(code: string): Promise<Record<string, Player>> {
  const players: Record<string, Player> = {};
  try {
    const iter = kv.list<Player>({ prefix: ["players", code] });
    for await (const res of iter) {
      if (res.key && res.key.length > 2) players[res.key[2] as string] = res.value;
    }
  } catch (e) {
    console.error(`Error listing players ${code}:`, e);
  }
  return players;
}
const getAlivePlayers = (players: Record<string, Player>): Record<string, Player> => Object.fromEntries(Object.entries(players).filter(([, p]) => p.alive));
const getHumanPlayers = (players: Record<string, Player>): Record<string, Player> => Object.fromEntries(Object.entries(players).filter(([, p]) => !p.isBot));
const findPlayersByRole = (players: Record<string, Player>, role: Role, aliveOnly = true): Player[] => Object.values(players).filter(p => p.role === role && (!aliveOnly || p.alive));
const getTargets = (players: Record<string, Player>, filter?: (p: Player) => boolean): Target[] => Object.values(players).filter(filter || (() => true)).map(p => ({ sid: p.sid, name: p.username }));

const getRandomElement = <T>(arr: T[]): T | undefined => arr.length > 0 ? arr[Math.floor(Math.random() * arr.length)] : undefined;

// --- Client Communication (aiMessage, promptAction, clearPrompt, updateRoomClients, broadcastRoomList - mostly same) ---
type MessageType = "ai_host" | "ai_private" | "ai_private_important" | "chat" | "ghost_chat" | "system";
async function aiMessage(code: string, message: string, type: MessageType = "ai_host", to_sids?: string | string[], sender: string = 'AI 主持人') {
  const players = await getPlayersInRoom(code);
  const human_sids = Object.keys(getHumanPlayers(players));
  if (human_sids.length === 0) return;

  let target: string | string[] = code;
  if (to_sids) {
    const human_targets = (Array.isArray(to_sids) ? to_sids : [to_sids]).filter(sid => human_sids.includes(sid));
    if (human_targets.length === 0) return;
    target = human_targets;
  }
  io.to(target).emit('game_message', { sender: sender, msg: message, type: type });
  console.log(`AI (${type}) -> ${JSON.stringify(target)}: ${message.substring(0, 80)}...`);
}

async function promptAction(code: string, action: ActionType, message: string, to_sids: string[], targets: Target[], timeout: number, addSkip = false) {
  const players = await getPlayersInRoom(code);
  const human_sids = Object.keys(getHumanPlayers(players));
  const recipients = to_sids.filter(sid => human_sids.includes(sid) && players[sid]?.alive);
  if (recipients.length === 0) return;

  const finalTargets = [...targets];
  if (addSkip) finalTargets.push({ sid: 'SKIP', name: '跳过/弃权' });
  io.to(recipients).emit('prompt_action', { action_type: action, message, targets: finalTargets, timeout });
  console.log(`PROMPT (${action}, ${timeout}s) -> ${recipients} for targets: ${finalTargets.map(t => t.name).join(',')}`);
}

function clearPrompt(to_sids: string | string[]) {
  io.to(to_sids).emit('prompt_action', null);
}

async function updateRoomClients(code: string) {
  const room = await getRoom(code);
  if (!room) return;
  const players = await getPlayersInRoom(code);
  const humanPlayers = getHumanPlayers(players);
  if (Object.keys(humanPlayers).length === 0) return;

  const host_username = players[room.host_sid]?.username || (room.host_sid ? '未知' : '无');
  const showRoles = room.state === 'OVER';
  const lovers = new Set(room.lovers_sids || []);

  console.log(`Updating room ${code} clients. State: ${room.state}, Players: ${room.player_count}`);

  for (const [sid, player] of Object.entries(humanPlayers)) {
    const safe_players: any[] = [];
    for (const [p_sid, p_info] of Object.entries(players)) {
      const is_self = (p_sid === sid);
      const role_display = p_info.role ? ROLE_NAME[p_info.role] : '等待';
      let role_info = '等待';
      const showRealRole = is_self || showRoles || (player.role === 'WOLF' && p_info.role === 'WOLF' && player.alive);
      if (p_info.role) {
        role_info = showRealRole ? role_display : (p_info.alive ? '存活' : '出局');
        // Lovers see each other's role
        if (!showRealRole && player.is_lover && p_info.is_lover) role_info = role_display;
      }
      if (!player.alive && !showRoles && p_info.role) role_info = `${role_display} (${p_info.alive ? '存活' : '出局'})`;
      // Dead see all
      const statusSuffix = (p_info.is_lover ? ' ❤️' : '') + (p_info.idiot_revealed ? ' 🤪' : '');

      safe_players.push({
        username: p_info.username + (p_info.isBot ? ' (AI)' : '') + statusSuffix,
        sid: p_sid, role: role_info, alive: p_info.alive, is_self, is_host: (p_sid === room.host_sid), is_bot: !!p_info.isBot,
      });
    }
    const client_state = {
      room_name: room.name, room_code: code, players: safe_players, game_state: STATE_NAME[room.state],
      my_role: player.role ? ROLE_NAME[player.role] : null, my_role_desc: player.role ? ROLE_DESC[player.role] : null,
      am_i_alive: player.alive, host_username: host_username,
      winner: room.winner ? (room.winner === 'GOOD' ? '好人阵营' : room.winner === 'WOLF' ? '狼人阵营' : '情侣阵营') : null,
      is_lover: player.is_lover, can_vote: !player.idiot_revealed,
    };
    io.to(sid).emit('update_state', client_state);
  }
  await broadcastRoomList();
}

async function getRoomList(): Promise<RoomInfo[]> {
  const rooms: RoomInfo[] = [];
  const iter = kv.list<RoomInfo>({ prefix: ["room_list_info"] });
  for await (const res of iter) {
    if (res.value && res.value.state === 'WAITING') rooms.push(res.value);
  }
  return rooms;
}

async function broadcastRoomList() {
  try {
    io.emit('room_list', await getRoomList());
  } catch (e) {
    console.error("Broadcast fail", e)
  }
}

// --- Game Logic Helpers ---

// Check win condition - complex!
function checkWinCondition(players: Record<string, Player>, room: Room): Winner {
  const alive = Object.values(getAlivePlayers(players));
  if (alive.length === 0) return 'DRAW';

  const lovers = alive.filter(p => p.is_lover);
  const aliveWolves = alive.filter(p => p.role === 'WOLF' && !p.is_lover); // non-lover wolves
  const aliveGood = alive.filter(p => p.role !== 'WOLF' && !p.is_lover); // non-lover good

  // 1. LOVER WIN (only 2 lovers left, regardless of original roles)
  if (lovers.length === 2 && aliveWolves.length === 0 && aliveGood.length === 0) return 'LOVER';

  // If lovers exist but don't meet win con, they count towards their original alignment count
  const totalWolves = alive.filter(p => getAlignment(p.original_role) === 'WOLF').length;
  const totalGood = alive.filter(p => getAlignment(p.original_role) === 'GOOD').length;

  // 2. GOOD WIN
  if (totalWolves === 0) return 'GOOD';
  // 3. WOLF WIN (Tu Bian)
  if (totalWolves >= totalGood) return 'WOLF';

  return 'NONE';
}

// APPLY DEATHS & TRIGGER EFFECTS: Hunter, Idiot, Lovers
async function applyDeathsAndCheckTriggers(code: string, room: Room, players: Record<string, Player>, initialDeaths: Map<string, DeathReason>): Promise<{ nextQueueMsg: QueueMessage, messages: string[] }> {
  const messages: string[] = [];
  const allDeaths = new Map(initialDeaths);
  let hunterToShoot: string | null = null;
  let idiotRevealed: Player | null = null;

  // 1. Process Lovers
  let loverDied = true;
  while (loverDied) { // Loop in case of chain reaction (unlikely but safe)
    loverDied = false;
    for (const [deadSid,] of allDeaths) {
      if (players[deadSid]?.is_lover) {
        const partnerSid = room.lovers_sids.find(sid => sid !== deadSid);
        if (partnerSid && players[partnerSid]?.alive && !allDeaths.has(partnerSid)) {
          allDeaths.set(partnerSid, 'LOVER');
          messages.push(`【${players[partnerSid].username}】 为爱殉情！`);
          loverDied = true;
        }
      }
    }
  }

  // 2. Check Idiot & Hunter Triggers based on *final* death list
  for (const [deadSid, reason] of allDeaths) {
    const player = players[deadSid];
    if (!player) continue;

    // Idiot reveal
    if (reason === 'VOTE' && player.role === 'IDIOT' && !player.idiot_revealed) {
      idiotRevealed = player;
      allDeaths.delete(deadSid); // REMOVE from death list
      players[deadSid].idiot_revealed = true; // Update in memory
      messages.push(`【${player.username}】 翻牌为白痴，免于放逐，但失去投票权！`);
      // If idiot was a lover and is now saved, their partner might also be saved if the only reason was LOVER? Complex. Assume partner still dies for simplicity.
      continue; // No hunter shot if idiot saved
    }
    // Hunter shot
    if (player.role === 'HUNTER' && (reason === 'WOLF' || reason === 'VOTE') && !hunterToShoot) {
      hunterToShoot = deadSid; // Only one hunter shoots
      messages.push(`【${player.username}】 发动猎人技能，请选择一名玩家带走！`);
    }
  }

  // 3. Apply final deaths to memory map
  const finalDeadPlayers: Player[] = [];
  allDeaths.forEach((_reason, sid) => {
    if (players[sid]?.alive) {
      players[sid].alive = false;
      finalDeadPlayers.push(players[sid]);
    }
  });
  if (finalDeadPlayers.length > 0) messages.unshift(`出局玩家: ${finalDeadPlayers.map(p => p.username).join(', ')}.`);
  else if (initialDeaths.size > 0 && !idiotRevealed) messages.unshift("本轮没有玩家出局 (被守护/被救/平安夜)。");
  else if (initialDeaths.size === 0) messages.unshift("平安夜 / 无人被放逐。");

  // 4. Atomic Commit all player state changes (deaths, idiot_reveal)
  const op = kv.atomic();
  Object.values(players).forEach(p => op.set(getPlayerKey(code, p.sid), p));
  await op.commit();
  await updateRoomClients(code); // Show deaths/idiot

  // 5. Determine Next Step
  let nextQueueMsg: QueueMessage;
  // If hunter shoots, go to hunter phase BEFORE checking win
  if (hunterToShoot) {
    nextQueueMsg = { type: 'CHECK_WIN_AND_NEXT', code, day: room.day, trigger_sid: hunterToShoot, deaths: allDeaths }; // Pass info
    // Special handling: trigger hunter directly
    await handleHunterPrompt(code, room, players, hunterToShoot);
  } else {
    // No hunter, just check win condition now
    nextQueueMsg = { type: 'CHECK_WIN_AND_NEXT', code, day: room.day, deaths: allDeaths };
  }
  // Return message, caller MUST enqueue the returned nextQueueMsg with SHORT_DELAY or handle hunter.
  return { nextQueueMsg, messages: messages.filter(m => m) };
}

async function handleHunterPrompt(code: string, room: Room, players: Record<string, Player>, hunterSid: string) {
  const hunter = players[hunterSid];
  if (!hunter) return;

  await kv.atomic().set(getRoomKey(code), { ...room, state: 'HUNTER_SHOOT' }).commit();
  await updateRoomClients(code);

  const targets = getTargets(getAlivePlayers(players), p => p.sid !== hunterSid);
  if (!hunter.isBot) await promptAction(code, 'shoot', '请开枪:', [hunterSid], targets, HUNTER_DURATION_SEC, true);
  else { // Bot hunter logic
    const target = getRandomElement(targets);
    if (target) players[hunterSid].target_sid = target.sid; else players[hunterSid].target_sid = 'SKIP';
    await kv.set(getPlayerKey(code, hunterSid), players[hunterSid]); // Save bot choice
  }
  enqueue({ type: 'HUNTER_SHOOT_END', code, day: room.day, trigger_sid: hunterSid }, hunter.isBot ? 1 : HUNTER_DURATION_SEC);
}

// Centralized win check and next phase routing
async function routeNextPhase(msg: QueueMessage, room: Room, players: Record<string, Player>) {
  const winner = checkWinCondition(players, room);
  console.log(`WIN CHECK: Room ${room.code}, Day ${room.day}, State ${room.state}, Winner: ${winner}`);
  if (winner !== 'NONE') {
    enqueue({ type: 'END_GAME', code: room.code, day: room.day, winner }, SHORT_DELAY_SEC);
  } else {
    // Decide next phase based on previous state
    const fromVoting = room.state === 'VOTING' || (room.state === 'HUNTER_SHOOT' && msg.type === 'HUNTER_SHOOT_END' && !msg.deaths?.size); // Hunter shot after vote
    const fromNight = room.state === 'NIGHT' || (room.state === 'HUNTER_SHOOT' && msg.type === 'HUNTER_SHOOT_END' && msg.deaths && msg.deaths.size > 0); // Hunter shot after night

    if (fromVoting) {
      enqueue({ type: 'NIGHT_START', code: room.code, day: room.day + 1 }, SHORT_DELAY_SEC);
    } else if (fromNight) {
      enqueue({ type: 'DAY_START_DISCUSSION', code: room.code, day: room.day }, SHORT_DELAY_SEC);
    } else {
      // Fallback / error state
      console.error(`Cannot determine next phase for room ${room.code} state ${room.state}`);
      enqueue({ type: 'NIGHT_START', code: room.code, day: room.day + 1 }, SHORT_DELAY_SEC);
    }
  }
}

// Calculate result (kill or vote) - MODIFIED for skip
function calculateResult(players: Record<string, Player>, voters: Player[], property: 'target_sid' | 'voted_for'): string | null {
  const votes: Record<string, number> = {};
  const aliveSids = new Set(Object.keys(getAlivePlayers(players)));
  let skipCount = 0;
  voters.forEach(p => {
    const target = p[property];
    if (target === 'SKIP') skipCount++;
    else if (target && aliveSids.has(target)) votes[target] = (votes[target] || 0) + 1;
  });
  if (Object.keys(votes).length === 0) return null; // all skipped or invalid

  let maxVotes = 0;
  let topCandidates: string[] = [];
  for (const [sid, count] of Object.entries(votes)) {
    if (count > maxVotes) {
      maxVotes = count;
      topCandidates = [sid];
    } else if (count > 0 && count === maxVotes) {
      topCandidates.push(sid);
    }
  }
  // If max vote count is not more than skip count, or tie, consider it null (except wolves must agree)
  // For voting: if maxVotes <= skipCount, nobody dies.
  if (property === 'voted_for' && (maxVotes <= skipCount || topCandidates.length > 1)) {
    // Tie or majority skip in voting = no one dies. For Wolves, tie = random.
    return null;
  }
  return getRandomElement(topCandidates) || null;
}

// Generate Bot Actions - IMPROVED
function performBotAction(bot: Player, room: Room, players: Record<string, Player>, action: ActionType) {
  if (!bot.alive || !bot.isBot) return;
  let targetSid: string | null = 'SKIP'; // Default
  const alivePlayers = getAlivePlayers(players);
  const aliveSids = Object.keys(alivePlayers);
  let possibleTargets: string[] = [];

  switch (action) {
    case 'guard': possibleTargets = aliveSids.filter(sid => sid !== bot.sid && sid !== room.guard_last_protect_sid); break;
    case 'kill': possibleTargets = aliveSids.filter(sid => alivePlayers[sid].role !== 'WOLF'); break;
    case 'heal': targetSid = room.night_wolf_kill_sid && Math.random() < 0.6 ? room.night_wolf_kill_sid : 'SKIP'; break; // 60% chance to heal
    case 'poison': possibleTargets = aliveSids.filter(sid => sid !== bot.sid); if (Math.random() > 0.4) possibleTargets = []; break; // 40% chance to poison
    case 'check': possibleTargets = aliveSids.filter(sid => sid !== bot.sid); break;
    case 'vote': possibleTargets = aliveSids.filter(sid => sid !== bot.sid && !alivePlayers[sid].idiot_revealed); break;
    case 'shoot': possibleTargets = aliveSids.filter(sid => sid !== bot.sid); break;
    case 'link_1': {
      // Cupid first lover selection
      possibleTargets = aliveSids.filter(sid => sid !== bot.sid);
      if (possibleTargets.length > 0) {
        targetSid = getRandomElement(possibleTargets) || 'SKIP';
        bot.cupid_first_lover = targetSid; // Store for link_2
      }
      break;
    }
    case 'link_2': {
      // Cupid second lover selection
      possibleTargets = aliveSids.filter(sid => sid !== bot.sid && sid !== bot.cupid_first_lover);
      if (possibleTargets.length > 0) {
        targetSid = getRandomElement(possibleTargets) || 'SKIP';
      }
      break;
    }
    case 'choose_role': {
      const choices = room.thief_choices || [];
      if (choices.includes('WOLF')) bot.target_sid = 'WOLF'; else bot.target_sid = getRandomElement(choices) || null;
      return; // Special handling
    }
  }
  if (possibleTargets.length > 0 && action !== 'link_1' && action !== 'link_2') {
    targetSid = getRandomElement(possibleTargets) || 'SKIP';
  }
  const prop = (action === 'vote') ? 'voted_for' : 'target_sid';
  if (targetSid) players[bot.sid][prop] = targetSid;
  console.log(`BOT ${bot.username} (${action}) -> ${targetSid}`);
}

// Assign Roles - MODIFIED for THIEF
async function assignRoles(code: string, room: Room, players: Record<string, Player>): Promise<boolean> {
  const playerCount = Object.keys(players).length;
  const config = ROLE_CONFIG[playerCount];
  if (!config) return false;
  const shuffledRoles = shuffle([...config.roles]); // copy
  const baseRoles = shuffledRoles.slice(0, playerCount);
  const extraRoles = shuffledRoles.slice(playerCount); // For thief

  const op = kv.atomic();
  const sids = Object.keys(players);
  let thiefSid: string | null = null;
  for (let i = 0; i < sids.length; i++) {
    const role = baseRoles[i];
    const player: Player = { ...players[sids[i]], role: role, original_role: role, alive: true, voted_for: null, target_sid: null, cupid_first_lover: null, is_lover: false, idiot_revealed: false };
    op.set(getPlayerKey(code, sids[i]), player);
    if (role === 'THIEF') thiefSid = sids[i];
  }
  // Update room with thief choices if applicable
  if (thiefSid && extraRoles.length > 0) {
    const updatedRoom: Room = { ...room, state: 'STARTING', day: 0, winner: null, witch_has_heal: true, witch_has_poison: true, guard_last_protect_sid: null, lovers_sids: [], thief_choices: extraRoles, night_wolf_kill_sid: null, night_guarded_sid: null, night_healed: false, night_poisoned_sid: null };
    op.set(getRoomKey(code), updatedRoom);
  } else {
    const updatedRoom: Room = { ...room, state: 'STARTING', day: 0, winner: null, witch_has_heal: true, witch_has_poison: true, guard_last_protect_sid: null, lovers_sids: [], thief_choices: [], night_wolf_kill_sid: null, night_guarded_sid: null, night_healed: false, night_poisoned_sid: null };
    op.set(getRoomKey(code), updatedRoom);
  }
  op.set(getRoomListInfoKey(code), { ...(await kv.get<RoomInfo>(getRoomListInfoKey(code))).value, state: 'STARTING' } as RoomInfo);
  const res = await op.commit();
  return res.ok;
}

const resetPlayerTargets = (op: Deno.AtomicOperation, code: string, players: Record<string, Player>) =>
  Object.values(players).forEach(p => {
    if (p.alive) op.set(getPlayerKey(code, p.sid), { ...p, voted_for: null, target_sid: null, cupid_first_lover: null });
  });

//--- Game State Machine via kv.listenQueue ---
async function enqueue(msg: QueueMessage, delaySeconds: number) {
  console.log(`QUEUE: Enqueuing ${msg.type} for ${msg.code} day ${msg.day} in ${delaySeconds}s`);
  await kv.enqueue(msg, { delay: Math.max(1, delaySeconds) * 1000 });
}

async function validateState(code: string, validStates: RoomState[]): Promise<{ room: Room, players: Record<string, Player> } | null> {
  const room = await getRoom(code);
  if (!room || !validStates.includes(room.state) || room.state === 'OVER' || room.state === 'WAITING') {
    // console.warn(`QUEUE: Room ${code} invalid state ${room?.state}, expecting ${validStates}, msg dropped.`);
    return null;
  }
  const players = await getPlayersInRoom(code);
  if (Object.keys(getHumanPlayers(players)).length === 0) {
    await handleAllHumansLeft(code);
    return null;
  }
  return { room, players };
}

async function handleStartGame(room: Room, players: Record<string, Player>) {
  if (!await assignRoles(room.code, room, players)) return;
  await updateRoomClients(room.code); // Show roles & state STARTING
  await aiMessage(room.code, "游戏开始！身份已分配。");
  enqueue({ type: 'NIGHT_0_START', code: room.code, day: 0 }, SHORT_DELAY_SEC);
}

// The LOOP
kv.listenQueue(async (msg: unknown) => {
  const q = msg as QueueMessage;
  if (!q?.type || !q.code) return;
  console.log(`QUEUE: Received ${q.type} for room ${q.code}, Day ${q.day}`);
  const { code, day } = q;
  let data, player: Player | undefined, players: Record<string, Player>, room: Room;

  try {
    // NIGHT 0: THIEF & CUPID
    if (q.type === 'NIGHT_0_START') {
      data = await validateState(code, ['STARTING']);
      if (!data) return;
      ({ room, players } = data);
      await kv.atomic().set(getRoomKey(code), { ...room, state: 'NIGHT_0' }).commit();
      await updateRoomClients(code);
      await aiMessage(code, "--- 游戏设置阶段 (第 0 夜) ---");
      const thief = findPlayersByRole(players, 'THIEF')[0];
      if (thief) {
        const targets: Target[] = room.thief_choices.map(r => ({ sid: r, name: ROLE_NAME[r] }));
        await aiMessage(code, "盗贼请选择身份：", "ai_host", thief.isBot ? undefined : [thief.sid]);
        if (!thief.isBot) await promptAction(code, 'choose_role', '请选择你的身份:', [thief.sid], targets, ACTION_DURATION_SEC);
        else performBotAction(thief, room, players, 'choose_role');
        enqueue({ type: 'NIGHT_0_THIEF_END', code, day }, thief.isBot ? 1 : ACTION_DURATION_SEC);
      } else {
        enqueue({ type: 'NIGHT_0_THIEF_END', code, day }, 1);
      } // Skip
    } else if (q.type === 'NIGHT_0_THIEF_END') {
      data = await validateState(code, ['NIGHT_0']);
      if (!data) return;
      ({ room, players } = data);
      clearPrompt(code);
      const thief = findPlayersByRole(players, 'THIEF')[0];
      if (thief && thief.target_sid && room.thief_choices.includes(thief.target_sid as Role)) {
        const chosenRole = thief.target_sid as Role;
        players[thief.sid].role = chosenRole;
        players[thief.sid].original_role = chosenRole;
        await kv.set(getPlayerKey(code, thief.sid), players[thief.sid]);
        await updateRoomClients(code);
        await aiMessage(code, `盗贼选择了身份：【${ROLE_NAME[chosenRole]}】`, 'ai_host');
        if (!thief.isBot) await aiMessage(code, `你的身份已变为：${ROLE_NAME[chosenRole]}`, 'ai_private_important', [thief.sid]);
      }
      const cupid = findPlayersByRole(players, 'CUPID')[0];
      if (cupid) {
        await aiMessage(code, "丘比特请连接情侣：", "ai_host", cupid.isBot ? undefined : [cupid.sid]);
        const targets = getTargets(players);
        if (!cupid.isBot) await promptAction(code, 'link_1', '请选择第一位情侣:', [cupid.sid], targets, ACTION_DURATION_SEC);
        else {
          performBotAction(cupid, room, players, 'link_1');
          await kv.set(getPlayerKey(code, cupid.sid), players[cupid.sid]); // Save first choice
        }
        enqueue({ type: 'NIGHT_0_CUPID_END', code, day }, cupid.isBot ? 1 : ACTION_DURATION_SEC);
      } else {
        enqueue({ type: 'NIGHT_0_CUPID_END', code, day }, 1);
      } // Skip to end
    } else if (q.type === 'NIGHT_0_CUPID_END') {
      // Handle cupid linking with improved bot logic
      data = await validateState(code, ['NIGHT_0']);
      if (!data) return;
      ({ room, players } = data);
      clearPrompt(code);
      const cupid = findPlayersByRole(players, 'CUPID')[0];

      if (cupid) {
        let lover1Sid: string | null = null;
        let lover2Sid: string | null = null;

        if (cupid.isBot) {
          // Bot cupid: use stored first lover and generate second
          lover1Sid = cupid.cupid_first_lover;
          performBotAction(cupid, room, players, 'link_2');
          lover2Sid = cupid.target_sid;
        } else {
          // Human cupid: expect two separate actions or handle special case
          // For simplicity, we'll use the target_sid as first lover and randomly pick second
          // In a real implementation, you'd track both selections properly
          lover1Sid = cupid.target_sid;
          const possibleSecond = Object.keys(players).filter(sid => sid !== cupid.sid && sid !== lover1Sid);
          lover2Sid = getRandomElement(possibleSecond) || null;
        }

        if (lover1Sid && lover2Sid && lover1Sid !== lover2Sid && players[lover1Sid] && players[lover2Sid]) {
          const lover1 = players[lover1Sid];
          const lover2 = players[lover2Sid];
          lover1.is_lover = true;
          lover2.is_lover = true;
          room.lovers_sids = [lover1Sid, lover2Sid];
          const op = kv.atomic()
            .set(getPlayerKey(code, lover1Sid), lover1)
            .set(getPlayerKey(code, lover2Sid), lover2)
            .set(getRoomKey(code), room);
          await op.commit();
          await updateRoomClients(code);
          await aiMessage(code, `丘比特将 【${lover1.username}】 和 【${lover2.username}】 连接为情侣！`, 'ai_host');
          if (!lover1.isBot) await aiMessage(code, `你与 【${lover2.username}】 成为情侣!`, 'ai_private_important', [lover1Sid]);
          if (!lover2.isBot) await aiMessage(code, `你与 【${lover1.username}】 成为情侣!`, 'ai_private_important', [lover2Sid]);
        }
      }
      enqueue({ type: 'NIGHT_START', code, day: 1 }, SHORT_DELAY_SEC); // Start Day 1 Night
    }

    // REGULAR NIGHT LOOP (Day >= 1)
    else if (q.type === 'NIGHT_START') {
      data = await validateState(code, ['NIGHT_0', 'VOTING', 'HUNTER_SHOOT']);
      if (!data) return;
      ({ room, players } = data);
      const op = kv.atomic().set(getRoomKey(code), { ...room, state: 'NIGHT', day: day, night_wolf_kill_sid: null, night_guarded_sid: room.night_guarded_sid, night_healed: false, night_poisoned_sid: null });
      resetPlayerTargets(op, code, players);
      await op.commit();
      await updateRoomClients(code);
      await aiMessage(code, `--- 第 ${day} 天，黑夜降临 ---\n天黑请闭眼...`);
      player = findPlayersByRole(players, 'GUARD')[0];
      const timeout = player?.isBot ? 1 : ACTION_DURATION_SEC;
      if (player) {
        const targets = getTargets(getAlivePlayers(players), p => p.sid !== room.guard_last_protect_sid);
        if (!player.isBot) await promptAction(code, 'guard', '守卫请守护:', [player.sid], targets, timeout, true);
        else performBotAction(player, room, players, 'guard');
      }
      enqueue({ type: 'NIGHT_GUARD_END', code, day }, player ? timeout : 1);
    } else if (q.type === 'NIGHT_GUARD_END') {
      data = await validateState(code, ['NIGHT']);
      if (!data) return;
      ({ room, players } = data);
      clearPrompt(code);
      player = findPlayersByRole(players, 'GUARD')[0];
      if (player?.target_sid && player.target_sid !== 'SKIP') room.night_guarded_sid = player.target_sid;
      else room.night_guarded_sid = null;
      await kv.set(getRoomKey(code), room);
      const wolves = findPlayersByRole(players, 'WOLF');
      const timeout = wolves.every(p => p.isBot) ? 1 : ACTION_DURATION_SEC;
      if (wolves.length > 0) {
        const targets = getTargets(getAlivePlayers(players), p => p.role !== 'WOLF');
        const sids = wolves.map(p => p.sid);
        if (targets.length > 0) await promptAction(code, 'kill', '狼人请猎杀:', sids.filter(s => !players[s].isBot), targets, timeout, true);
        wolves.forEach(w => performBotAction(w, room, players, 'kill'));
      }
      enqueue({ type: 'NIGHT_WOLF_END', code, day }, wolves.length > 0 ? timeout : 1);
    } else if (q.type === 'NIGHT_WOLF_END') {
      data = await validateState(code, ['NIGHT']);
      if (!data) return;
      ({ room, players } = data);
      clearPrompt(code);
      const wolves = findPlayersByRole(players, 'WOLF');
      room.night_wolf_kill_sid = calculateResult(players, wolves, 'target_sid');
      await kv.set(getRoomKey(code), room);
      player = findPlayersByRole(players, 'WITCH')[0];
      const timeout = player?.isBot ? 1 : ACTION_DURATION_SEC / 2;
      if (player && room.witch_has_heal && room.night_wolf_kill_sid) { // only prompt heal if someone attacked
        const victimName = players[room.night_wolf_kill_sid]?.username;
        const msg = `女巫, ${victimName} 被袭击，使用解药吗?`;
        const targets: Target[] = [{ sid: room.night_wolf_kill_sid, name: `救活 ${victimName}` }];
        if (!player.isBot) await promptAction(code, 'heal', msg, [player.sid], targets, timeout, true);
        else performBotAction(player, room, players, 'heal');
        enqueue({ type: 'NIGHT_WITCH_HEAL_END', code, day }, timeout);
      } else enqueue({ type: 'NIGHT_WITCH_HEAL_END', code, day }, 1);
    } else if (q.type === 'NIGHT_WITCH_HEAL_END') {
      data = await validateState(code, ['NIGHT']);
      if (!data) return;
      ({ room, players } = data);
      clearPrompt(code);
      player = findPlayersByRole(players, 'WITCH')[0];
      if (player && player.target_sid === room.night_wolf_kill_sid && room.witch_has_heal) { // Check if witch chose to heal the victim
        room.night_healed = true;
        room.witch_has_heal = false;
        await kv.set(getRoomKey(code), room);
      }
      // IMPORTANT: Clear witch target regardless, ready for poison check
      if (player) {
        players[player.sid].target_sid = null;
        await kv.set(getPlayerKey(code, player.sid), players[player.sid]);
      }

      const timeout = player?.isBot ? 1 : ACTION_DURATION_SEC / 2;
      if (player && room.witch_has_poison && !room.night_healed) { // cannot poison if healed
        const targets = getTargets(getAlivePlayers(players), p => p.sid !== player?.sid);
        if (!player.isBot) await promptAction(code, 'poison', '女巫,使用毒药吗?', [player.sid], targets, timeout, true);
        else performBotAction(player, room, players, 'poison');
        enqueue({ type: 'NIGHT_WITCH_POISON_END', code, day }, timeout);
      } else enqueue({ type: 'NIGHT_WITCH_POISON_END', code, day }, 1);
    }
    else if (q.type === 'NIGHT_WITCH_POISON_END') {
      data = await validateState(code, ['NIGHT']);
      if (!data) return;
      ({ room, players } = data);
      clearPrompt(code);
      player = findPlayersByRole(players, 'WITCH')[0];
      if (player && player.target_sid && player.target_sid !== 'SKIP' && room.witch_has_poison && !room.night_healed) {
        room.night_poisoned_sid = player.target_sid;
        room.witch_has_poison = false;
        await kv.set(getRoomKey(code), room);
      }
      player = findPlayersByRole(players, 'SEER')[0];
      const timeout = player?.isBot ? 1 : ACTION_DURATION_SEC;
      if (player) {
        const targets = getTargets(getAlivePlayers(players), p => p.sid !== player?.sid);
        if (!player.isBot) await promptAction(code, 'check', '预言家请查验:', [player.sid], targets, timeout, true);
        else performBotAction(player, room, players, 'check');
      }
      enqueue({ type: 'NIGHT_SEER_END', code, day }, player ? timeout : 1);
    }
    else if (q.type === 'NIGHT_SEER_END') {
      data = await validateState(code, ['NIGHT']);
      if (!data) return;
      ({ room, players } = data);
      clearPrompt(code);
      player = findPlayersByRole(players, 'SEER')[0];
      if (player && player.target_sid && player.target_sid !== 'SKIP' && players[player.target_sid]) {
        const target = players[player.target_sid];
        const align = target.is_lover ? '❤️情侣' : (getAlignment(target.role) === 'GOOD' ? '😊好人' : '🐺狼人');
        if (!player.isBot) await aiMessage(code, `【查验】 ${target.username} 是: ${align}`, "ai_private_important", [player.sid]);
      }
      enqueue({ type: 'DAY_ANNOUNCE', code, day }, REVEAL_DURATION_SEC);
    }

    // DAY / ANNOUNCE
    else if (q.type === 'DAY_ANNOUNCE') {
      data = await validateState(code, ['NIGHT']);
      if (!data) return;
      ({ room, players } = data);
      await aiMessage(code, `--- 第 ${day} 天，天亮了 ---`);
      const deaths = new Map<string, DeathReason>();
      const wolfKill = room.night_wolf_kill_sid;
      const guarded = room.night_guarded_sid;
      const healed = room.night_healed;
      const poison = room.night_poisoned_sid;

      // Resolve kill
      if (wolfKill && wolfKill !== guarded && !healed) deaths.set(wolfKill, 'WOLF');
      // Resolve poison
      if (poison) deaths.set(poison, 'POISON'); // Poison overrides guard/heal on same target

      const { nextQueueMsg, messages } = await applyDeathsAndCheckTriggers(code, room, players, deaths);
      await aiMessage(code, messages.join('\n'));
      // If hunter prompt was NOT triggered by applyDeaths
      if (nextQueueMsg.type === 'CHECK_WIN_AND_NEXT' && !nextQueueMsg.trigger_sid) {
        enqueue(nextQueueMsg, REVEAL_DURATION_SEC);
      } // else hunter prompt handles its own next step
    }
    else if (q.type === 'DAY_START_DISCUSSION') {
      data = await validateState(code, ['NIGHT', 'HUNTER_SHOOT']);
      if (!data) return;
      ({ room, players } = data);
      await kv.atomic().set(getRoomKey(code), { ...room, state: 'DAY' }).commit();
      await updateRoomClients(code);
      if (Object.keys(getAlivePlayers(players)).length < 2) {
        await aiMessage(code, "人数不足，跳过讨论和投票。", "system");
        enqueue({ type: 'NIGHT_START', code, day: day + 1 }, SHORT_DELAY_SEC);
      } else {
        await aiMessage(code, `请开始讨论 (${DISCUSSION_DURATION_SEC}秒)...`);
        enqueue({ type: 'VOTING_START', code, day }, DISCUSSION_DURATION_SEC);
      }
    }

    // VOTING
    else if (q.type === 'VOTING_START') {
      data = await validateState(code, ['DAY']);
      if (!data) return;
      ({ room, players } = data);
      const op = kv.atomic().set(getRoomKey(code), { ...room, state: 'VOTING' });
      resetPlayerTargets(op, code, players);
      await op.commit();
      await updateRoomClients(code);
      await aiMessage(code, `--- 讨论结束，开始投票 (${VOTING_DURATION_SEC}秒) ---`);
      const alive = getAlivePlayers(players);
      const voters = Object.values(alive).filter(p => !p.idiot_revealed);
      const targets = getTargets(alive, p => !p.idiot_revealed); // cannot vote idiot
      const timeout = voters.every(p => p.isBot) ? 1 : VOTING_DURATION_SEC;
      await promptAction(code, 'vote', '请投票放逐:', voters.filter(p => !p.isBot).map(p => p.sid), targets, timeout, true);
      voters.forEach(p => performBotAction(p, room, players, 'vote'));
      enqueue({ type: 'VOTING_END', code, day }, timeout);
    } else if (q.type === 'VOTING_END') {
      data = await validateState(code, ['VOTING']);
      if (!data) return;
      ({ room, players } = data);
      clearPrompt(code);
      const voters = Object.values(getAlivePlayers(players)).filter(p => !p.idiot_revealed);
      const votedOutSid = calculateResult(players, voters, 'voted_for');
      await aiMessage(code, `--- 投票结束 ---`);
      const deaths = new Map<string, DeathReason>();
      if (votedOutSid) deaths.set(votedOutSid, 'VOTE');
      const { nextQueueMsg, messages } = await applyDeathsAndCheckTriggers(code, room, players, deaths);
      await aiMessage(code, messages.join('\n'));
      if (nextQueueMsg.type === 'CHECK_WIN_AND_NEXT' && !nextQueueMsg.trigger_sid) {
        enqueue(nextQueueMsg, REVEAL_DURATION_SEC);
      }
    }
    // HUNTER & WIN CHECK
    else if (q.type === 'HUNTER_SHOOT_END') {
      data = await validateState(code, ['HUNTER_SHOOT']);
      if (!data) return;
      ({ room, players } = data);
      clearPrompt(code);
      const hunter = players[q.trigger_sid || ''];
      const shotSid = hunter?.target_sid;
      const deaths = new Map<string, DeathReason>();
      if (hunter && shotSid && shotSid !== 'SKIP' && players[shotSid]?.alive) {
        deaths.set(shotSid, 'HUNTER');
        await aiMessage(code, `猎人开枪带走了 【${players[shotSid].username}】！`);
      } else await aiMessage(code, "猎人没有开枪。");
      // Pass previous deaths to properly determine next phase in routeNextPhase
      const { nextQueueMsg } = await applyDeathsAndCheckTriggers(code, room, players, deaths);
      // CHECK_WIN_AND_NEXT message from applyDeaths already contains original deaths info via closure or just check room state
      nextQueueMsg.deaths = q.deaths; // Pass original deaths context
      enqueue(nextQueueMsg, REVEAL_DURATION_SEC);
    } else if (q.type === 'CHECK_WIN_AND_NEXT') {
      // Can be called from multiple states, just ensure room exists
      room = (await getRoom(code))!;
      players = await getPlayersInRoom(code);
      if (!room || room.state === 'OVER' || room.state === 'WAITING') return;
      await routeNextPhase(q, room, players); // Check win and enqueue NIGHT_START or DAY_START_DISCUSSION or END_GAME
    }
    // END & RESET
    else if (q.type === 'END_GAME') {
      room = (await getRoom(code))!;
      players = await getPlayersInRoom(code);
      if (!room || room.state === 'OVER' || room.state === 'WAITING') return;
      clearPrompt(code);
      const finalWinner = q.winner || 'DRAW';
      const winnerName = finalWinner === 'GOOD' ? '好人阵营' : (finalWinner === 'WOLF' ? '狼人阵营' : finalWinner === 'LOVER' ? '情侣阵营' : '平局');
      await kv.atomic()
        .set(getRoomKey(code), { ...room, state: 'OVER', winner: finalWinner })
        .set(getRoomListInfoKey(code), { ...(await kv.get<RoomInfo>(getRoomListInfoKey(code))).value, state: 'OVER' } as RoomInfo)
        .commit();
      await aiMessage(code, `--- 游戏结束 ---\n恭喜 ${winnerName} 获得胜利！`);
      await updateRoomClients(code);
      enqueue({ type: 'RESET_ROOM', code, day: 0 }, 15);
    } else if (q.type === 'RESET_ROOM') {
      room = (await getRoom(code))!;
      players = await getPlayersInRoom(code);
      if (!room || room.state !== 'OVER') return;
      const op = kv.atomic()
        .set(getRoomKey(code), { ...room, state: 'WAITING', day: 0, winner: null, lovers_sids: [], thief_choices: [] })
        .set(getRoomListInfoKey(code), { ...(await kv.get<RoomInfo>(getRoomListInfoKey(code))).value, state: 'WAITING' } as RoomInfo);
      Object.values(players).forEach(p => op.set(getPlayerKey(code, p.sid), { ...p, role: null, original_role: null, alive: true, voted_for: null, target_sid: null, cupid_first_lover: null, is_lover: false, idiot_revealed: false }));
      await op.commit();
      await aiMessage(code, "房间已重置。", "system");
      await updateRoomClients(code);
    }

  } catch (error) {
    console.error(`QUEUE Error ${q.type}, ${code}:`, error);
  }
});

// --- Disconnect & Server (Same structure as before) ----
async function handleAllHumansLeft(code: string) {
  console.log(`Room ${code} empty, deleting.`);
  let op = kv.atomic().delete(getRoomKey(code)).delete(getRoomListInfoKey(code));
  for (const sid of Object.keys(await getPlayersInRoom(code)))
    op = op.delete(getPlayerKey(code, sid)).delete(getPlayerRoomKey(sid));
  await op.commit();
  await broadcastRoomList();
}

async function handlePlayerDisconnect(sid: string) {
  const roomCode = await getPlayerRoomCode(sid);
  if (!roomCode) return;
  const roomEntry = await getRoomEntry(roomCode);
  const room = roomEntry.value;
  if (!room) {
    await kv.delete(getPlayerRoomKey(sid));
    return;
  }
  const player = await getPlayer(roomCode, sid);
  if (!player) return;
  console.log(`Player ${player.username} (${sid}) disconnected from ${roomCode}`);
  const currentPlayers = await getPlayersInRoom(roomCode);
  delete currentPlayers[sid];
  if (Object.keys(getHumanPlayers(currentPlayers)).length <= 0) {
    await handleAllHumansLeft(roomCode);
    return;
  }

  // Handle in-game death
  const gameInProgress = !['WAITING', 'OVER'].includes(room.state);
  let gameEnded = false;
  if (gameInProgress && player.alive) {
    await aiMessage(roomCode, `玩家 【${player.username}】 离开游戏，视为出局。`);
    const deaths = new Map<string, DeathReason>([[sid, 'DISCONNECT']]);
    // Modify room/players in memory for check only, applyDeaths will commit
    const tempPlayers = { ...currentPlayers, [sid]: player }; // add back for trigger check
    const { messages } = await applyDeathsAndCheckTriggers(roomCode, room, tempPlayers, deaths);
    await aiMessage(roomCode, messages.join('\n'));
    const winner = checkWinCondition(tempPlayers, room); // Check after deaths
    if (winner !== 'NONE') {
      gameEnded = true;
      await aiMessage(roomCode, `因玩家离开，游戏结束!`);
      enqueue({ type: 'END_GAME', code: roomCode, day: room.day, winner }, 1);
    }
  } else {
    await aiMessage(roomCode, `玩家 【${player.username}】 离开了房间。`);
  }

  let newHostSid = room.host_sid;
  if (sid === room.host_sid) {
    const newHost = Object.entries(getHumanPlayers(currentPlayers))[0];
    if (newHost) {
      newHostSid = newHost[0];
      setTimeout(() => aiMessage(roomCode, `【${newHost[1].username}】 成为新房主。`), 200);
    } else newHostSid = '';
  }
  const newCount = Object.keys(currentPlayers).length;
  const updatedRoom: Partial<Room> = { player_count: newCount, host_sid: newHostSid };
  if (gameEnded) updatedRoom.state = 'OVER'; // Mark as over if game ended

  await kv.atomic().check(roomEntry).delete(getPlayerKey(roomCode, sid)).delete(getPlayerRoomKey(sid))
    .set(getRoomKey(roomCode), { ...room, ...updatedRoom })
    .set(getRoomListInfoKey(roomCode), { ...(await kv.get<RoomInfo>(getRoomListInfoKey(roomCode))).value, players: newCount, state: gameEnded ? 'OVER' : room.state } as RoomInfo)
    .commit();
  await updateRoomClients(roomCode); // Will broadcast
}

const io = new Server();
io.on("connection", (socket) => {
  console.log(`socket ${socket.id} connected`);
  broadcastRoomList();

  socket.on("disconnect", async (reason) => {
    await handlePlayerDisconnect(socket.id);
  });

  socket.on("request_room_list", async () => {
    socket.emit('room_list', await getRoomList());
  });

  // Add Bot, Create Room, Join Room, Leave Room, Send Chat -- mostly same as before
  socket.on("add_bot", async () => {
    const sid = socket.id;
    const roomCode = await getPlayerRoomCode(sid);
    if (!roomCode) return;
    const roomEntry = await getRoomEntry(roomCode);
    const room = roomEntry.value;
    if (!room || !roomEntry.versionstamp) return;
    if (sid !== room.host_sid || room.state !== 'WAITING' || room.player_count >= room.max_players) return;
    const currentPlayers = await getPlayersInRoom(roomCode);
    let botName = '';
    let attempt = 0;
    do {
      botName = 'AI_' + cryptoRandomString({ length: 4, type: 'numeric' });
      attempt++;
    } while (Object.values(currentPlayers).some(p => p.username === botName) && attempt < 10)
    const botSid = 'BOT_' + cryptoRandomString({ length: 8 });
    const newBot: Player = {
      username: botName,
      role: null,
      original_role: null,
      alive: true,
      sid: botSid,
      voted_for: null,
      target_sid: null,
      cupid_first_lover: null,
      isBot: true,
      is_lover: false,
      idiot_revealed: false
    };
    const newCount = room.player_count + 1;
    const res = await kv.atomic()
      .check(roomEntry)
      .set(getRoomKey(roomCode), { ...room, player_count: newCount })
      .set(getPlayerKey(roomCode, botSid), newBot)
      .set(getRoomListInfoKey(roomCode), { ...(await kv.get<RoomInfo>(getRoomListInfoKey(roomCode))).value, players: newCount } as RoomInfo)
      .commit();
    if (res.ok) {
      await aiMessage(roomCode, `添加了 ${botName}`);
      await updateRoomClients(roomCode);
    }
  });

  socket.on("create_room", async (data) => {
    const { username, room_name, password } = data;
    const sid = socket.id;
    if (!username || !room_name || await getPlayerRoomCode(sid)) return;
    let room_code = '';
    do {
      room_code = cryptoRandomString({ length: 6 }).toUpperCase();
    } while ((await getRoom(room_code)) !== null);
    const newRoom: Room = {
      name: room_name,
      code: room_code,
      password: password || undefined,
      host_sid: sid,
      state: 'WAITING',
      min_players: MIN_PLAYERS,
      max_players: MAX_PLAYERS,
      player_count: 1,
      day: 0,
      winner: null,
      witch_has_heal: true,
      witch_has_poison: true,
      guard_last_protect_sid: null,
      lovers_sids: [],
      thief_choices: [],
      night_wolf_kill_sid: null,
      night_guarded_sid: null,
      night_healed: false,
      night_poisoned_sid: null
    };
    const newPlayer: Player = {
      username,
      role: null,
      original_role: null,
      alive: true,
      sid,
      voted_for: null,
      target_sid: null,
      cupid_first_lover: null,
      isBot: false,
      is_lover: false,
      idiot_revealed: false
    };
    const roomInfo: RoomInfo = {
      code: room_code,
      name: room_name,
      players: 1,
      max_players: MAX_PLAYERS,
      has_password: !!password,
      state: 'WAITING'
    };
    const res = await kv.atomic()
      .set(getRoomKey(room_code), newRoom)
      .set(getPlayerKey(room_code, sid), newPlayer)
      .set(getPlayerRoomKey(sid), room_code)
      .set(getRoomListInfoKey(room_code), roomInfo)
      .commit();
    if (res.ok) {
      socket.join(room_code);
      socket.emit('join_success', { room_code });
      setTimeout(async () => {
        await aiMessage(room_code, `${username} 创建房间`);
        await updateRoomClients(room_code);
      }, 100);
    }
  });

  socket.on("join_room", async (data) => {
    const { username, room_code, password } = data;
    const code = (room_code || '').toUpperCase();
    const sid = socket.id;
    if (!username || !code || await getPlayerRoomCode(sid)) return;
    const roomEntry = await getRoomEntry(code);
    const room = roomEntry.value;
    if (!room || !roomEntry.versionstamp || room.state !== 'WAITING' || room.player_count >= room.max_players || (room.password && room.password !== password))
      return socket.emit('error_message', { msg: '加入失败' });
    const players = await getPlayersInRoom(code);
    if (Object.values(players).some(p => p.username.toLowerCase() === username.toLowerCase()))
      return socket.emit('error_message', { msg: '用户名重复' });
    const newPlayer: Player = {
      username,
      role: null,
      original_role: null,
      alive: true,
      sid,
      voted_for: null,
      target_sid: null,
      cupid_first_lover: null,
      isBot: false,
      is_lover: false,
      idiot_revealed: false
    };
    const newCount = room.player_count + 1;
    const res = await kv.atomic()
      .check(roomEntry)
      .set(getRoomKey(code), { ...room, player_count: newCount })
      .set(getPlayerKey(code, sid), newPlayer)
      .set(getPlayerRoomKey(sid), code)
      .set(getRoomListInfoKey(code), { ...(await kv.get<RoomInfo>(getRoomListInfoKey(code))).value, players: newCount } as RoomInfo)
      .commit();
    if (res.ok) {
      socket.join(code);
      socket.emit('join_success', { room_code: code });
      setTimeout(async () => {
        await aiMessage(code, `${username} 加入房间`);
        await updateRoomClients(code);
      }, 100);
    }
  });

  socket.on('leave_room', async () => {
    const sid = socket.id;
    const roomCode = await getPlayerRoomCode(sid);
    if (roomCode) socket.leave(roomCode);
    await handlePlayerDisconnect(socket.id);
    socket.emit('leave_success');
  });

  socket.on('send_chat', async (data) => {
    const sid = socket.id;
    const roomCode = await getPlayerRoomCode(sid);
    if (!roomCode || !data.msg) return;
    const room = await getRoom(roomCode);
    const player = await getPlayer(roomCode, sid);
    if (!room || !player || player.isBot) return;
    const gameInProgress = !['WAITING', 'OVER'].includes(room.state);
    const isDeadChat = gameInProgress && !player.alive;
    const sender = player.username + (isDeadChat ? '(灵魂)' : '') + (player.is_lover ? '❤️' : '');
    const type: MessageType = isDeadChat ? 'ghost_chat' : 'chat';
    if (isDeadChat) {
      const sids = Object.values(await getPlayersInRoom(roomCode)).filter(p => !p.alive && !p.isBot).map(p => p.sid);
      if (sids.length > 0) io.to(sids).emit('game_message', { sender, msg: data.msg, type });
    } else if (player.is_lover) {
      const players = await getPlayersInRoom(roomCode);
      const sids = room.lovers_sids.filter(s => !players[s]?.isBot);
      io.to(sids).emit('game_message', { sender, msg: data.msg, type, sender: sender + '[情侣频道]' });
    } else {
      io.to(roomCode).emit('game_message', { sender, msg: data.msg || '', type: type });
    }
  });

  socket.on('start_game', async () => {
    const sid = socket.id;
    const roomCode = await getPlayerRoomCode(sid);
    if (!roomCode) return;
    const room = await getRoom(roomCode);
    if (!room || sid !== room.host_sid || room.state !== 'WAITING') return;
    if (!Object.keys(ROLE_CONFIG).includes(String(room.player_count)))
      return socket.emit('error_message', { msg: `不支持 ${room.player_count} 人配置! 支持: ${Object.keys(ROLE_CONFIG).join(',')}` });
    await handleStartGame(room, await getPlayersInRoom(roomCode));
  });

  socket.on('game_action', async (data: { action_type: ActionType, target_sid: string }) => {
    const sid = socket.id;
    const { action_type, target_sid } = data;
    if (!action_type || !target_sid) return;
    const roomCode = await getPlayerRoomCode(sid);
    if (!roomCode) return;
    const playerEntry = await kv.get<Player>(getPlayerKey(roomCode, sid));
    const player = playerEntry.value;
    if (!player || !playerEntry.versionstamp || player.isBot || (!player.alive && action_type !== 'shoot')) return;
    let prop: 'target_sid' | 'voted_for' | 'cupid_first_lover' = 'target_sid';
    if (action_type === 'vote') prop = 'voted_for';
    else if (action_type === 'link_1') prop = 'cupid_first_lover';
    // TODO: More validation based on room.state and player.role
    const targetName = target_sid === 'SKIP' ? '跳过' : (target_sid.length < 8 ? target_sid : (await getPlayer(roomCode, target_sid))?.username);
    const res = await kv.atomic().check(playerEntry).set(getPlayerKey(roomCode, sid), { ...player, [prop]: target_sid }).commit();
    if (res.ok && targetName) await aiMessage(roomCode, `已选择: ${targetName}`, 'ai_private', sid, '你的操作');
  });
});

// HTTP Server
const modulePath = new URL('.', import.meta.url);
const baseDir = modulePath.protocol === "file:" ? (Deno.build.os === "windows" ? modulePath.pathname.substring(1) : modulePath.pathname) : "./";

const handler = io.handler(async (req) => {
  const path = new URL(req.url).pathname;
  try {
    if (path === "/" || path === "/index.html") return await serveFile(req, `${baseDir}templates/index.html`);
    if (path.startsWith("/static/") && !path.includes('..')) return await serveFile(req, `${baseDir}static/${path.substring(8)}`);
  } catch (e) {
    console.error(e);
    return new Response("Error", { status: 500 });
  }
  return new Response("Not Found", { status: 404 });
});

console.log("Server starting on http://localhost:8000");
Deno.serve({ port: 8000, hostname: "0.0.0.0" }, handler);