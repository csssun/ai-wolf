// static/client.js
$(function () {
  // --- 全局变量 ---
  const socket = io({ timeout: 10000, reconnectionAttempts: 5 });
  let state = {
    roomCode: null,
    username: null,
    sid: null,
    isHost: false,
    isAlive: true,
    canVote: true,
    isConnected: false,
    cupidFirstLover: null,
    timerInterval: null,
    countdown: 0
  };
  const MAX_PLAYERS = 12, MIN_PLAYERS = 6;
  const STATE_WAITING = "等待中", STATE_OVER = "已结束";
  const ROLE_CONFIG_CLIENT = { 6: {}, 8: {}, 10: {}, 12: {} };

  // --- 工具函数 ---
  function switchView(viewId) {
    $('.view').removeClass('active-view');
    $(viewId).addClass('active-view');
    if (viewId === '#lobby-view') resetLobby();
    scrollMessages();
  }

  function resetLobby() {
    Object.assign(state, {
      roomCode: null,
      isHost: false,
      isAlive: true,
      canVote: true,
      cupidFirstLover: null
    });
    $('#messages, #player-list, #action-buttons').empty();
    $('#my-role-info').html('你的身份: <strong>等待中</strong>');
    $('#winner-banner').text('').hide();
    $('#start-btn, #add-bot-btn').hide();
    clearActionArea();
    if (state.isConnected) socket.emit('request_room_list');
  }

  function showError(message, title = "提示") {
    $('#error-title').text(title);
    $('#error-message-text').html(message);
    $('#error-popup').fadeIn(200);
  }

  function updateConnectionStatus(connected) {
    state.isConnected = connected;
    $('#chat-message, #send-chat-btn, #create-btn, #join-btn, #refresh-list-btn, #quick-join-btn')
      .prop('disabled', !connected);
    const statusEl = $('#connection-status');
    if (connected) {
      statusEl.text('已连接服务器').css('color', 'lightgreen');
      setTimeout(() => statusEl.text(''), 2000);
    } else {
      statusEl.text('未连接服务器 / 正在重连...').css('color', 'var(--deep-red)');
    }
  }

  function scrollMessages() {
    const msgDiv = $('#messages');
    if (msgDiv.length === 0) return;
    if (msgDiv.scrollTop() + msgDiv.innerHeight() >= msgDiv[0].scrollHeight - 50)
      msgDiv.scrollTop(msgDiv[0].scrollHeight);
  }

  function clearActionArea() {
    $('#action-prompt').text('');
    $('#action-buttons').empty();
    $('#timer-display').text('');
    clearInterval(state.timerInterval);
    state.timerInterval = null;
    state.cupidFirstLover = null;
  }

  function getUsername() {
    let username = $('#username').val().trim();
    if (!state.isConnected) return showError("服务器连接失败或已断开，无法操作。"), null;
    if (!username) return showError("请输入昵称！"), null;
    username = username.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    localStorage.setItem('username', username);
    state.username = username;
    return username;
  }

  // --- 事件注册 ---
  // 1. socket连接事件
  socket.on('connect', () => {
    updateConnectionStatus(true);
    state.sid = socket.id;
    if (!state.roomCode) socket.emit('request_room_list');
  });
  socket.on('connect_error', err => {
    updateConnectionStatus(false);
    showError(`无法建立连接。<br/>错误: ${err.message}`, "连接错误");
  });
  socket.io.on("reconnect_attempt", () => updateConnectionStatus(false));
  socket.io.on("reconnect_failed", () => showError(`连接重建失败。请刷新页面。`, "连接失败"));
  socket.on('disconnect', reason => {
    updateConnectionStatus(false);
    showError(`与服务器的连接已断开。原因: ${reason}`, "连接断开");
    clearActionArea();
    if (state.roomCode) switchView('#lobby-view');
  });

  // 2. 服务端业务事件
  socket.on('error_message', data => showError(data.msg || '未知错误', "服务器错误"));
  socket.on('room_list', renderRoomList);
  socket.on('join_success', data => {
    state.roomCode = data.room_code;
    localStorage.setItem('last_room_code', state.roomCode);
    switchView('#room-view');
    $('#messages, #action-buttons').empty();
    $('#winner-banner').text('').hide();
    clearActionArea();
  });
  socket.on('leave_success', () => switchView('#lobby-view'));

  // 游戏状态同步（核心UI刷新）
  socket.on('update_state', renderState);

  // 聊天和消息
  socket.on('game_message', data => {
    if (!data || !state.roomCode) return;
    const messages = $('#messages');
    const msgClass = `msg-${data.type || 'system'}`;
    const sender = data.sender ? `<span class="sender">${data.sender}:</span> ` : '';
    const content = (data.msg || '').replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, '<br>');
    messages.append(`<div class="msg ${msgClass}"><p>${sender}${content}</p></div>`);
    scrollMessages();
  });

  // 操作提示
  socket.on('prompt_action', renderPromptAction);

  // --- 业务渲染函数 ---
  function renderRoomList(rooms) {
    const list = $('#room-list tbody');
    list.empty();
    updateConnectionStatus(state.isConnected);
    if (!state.isConnected) return list.append('<tr><td colspan="5" style="color: var(--deep-red);">连接失败。</td></tr>');
    if (!rooms || rooms.length === 0) return list.append('<tr><td colspan="5">当前没有开放的房间。</td></tr>');
    rooms.sort((a, b) => a.name.localeCompare(b.name));
    rooms.forEach(room => {
      const lock = room.has_password ? '🔒' : '🔓';
      const canJoin = room.state === 'WAITING' && state.isConnected && room.players < room.max_players;
      const joinBtn = `<button class="join-public-btn" data-code="${room.code}" data-password="${room.has_password}">加入</button>`;
      let actionCol = canJoin ? joinBtn : (room.players >= room.max_players ? '人满' : '进行中');
      if (!state.isConnected) actionCol = '未连接';
      list.append(`<tr><td>${room.name}</td><td>${room.code}</td><td>${room.players}/${room.max_players}</td><td>${lock}</td><td>${actionCol}</td></tr>`);
    });
  }

  function renderState(gameState) {
    if (!gameState || !state.roomCode) return;
    state.isAlive = gameState.am_i_alive;
    state.canVote = gameState.can_vote;
    $('#room-title').text(`房间: ${gameState.room_name} (代码: ${gameState.room_code})`);
    $('#player-count').text(`${gameState.players?.length || 0}/${MAX_PLAYERS}`);
    $('#game-state-display').text(gameState.game_state);
    $('#host-name').text(gameState.host_username || '无');

    // 胜利条幅
    if (gameState.winner) {
      $('#winner-banner').text(`🎉 恭喜 ${gameState.winner} 获得胜利！ 🎉`).slideDown();
      if (gameState.winner.includes('狼人')) $('#winner-banner').css({ 'background-color': 'var(--wolf-red)', 'border-color': 'white' });
      else if (gameState.winner.includes('情侣')) $('#winner-banner').css({ 'background-color': '#FF69B4', 'border-color': 'white' });
      else $('#winner-banner').css({ 'background-color': '#4CAF50', 'border-color': 'var(--gold-accent)' });
    } else {
      $('#winner-banner').slideUp();
    }

    // 玩家列表
    renderPlayerList(gameState.players || []);

    // 身份、操作按钮等
    $('#my-role-info').html(
      gameState.my_role ?
        `你的身份: <strong>${gameState.my_role}</strong> ${gameState.is_lover ? '❤️' : ''}<br><small>${gameState.my_role_desc || ''}</small>`
        : '你的身份: <strong>等待中</strong>'
    );

    // Start/加Bot按钮可见性
    state.isHost = !!(gameState.players?.find(p => p.is_self && p.is_host));
    const canStart = state.isHost && gameState.game_state === STATE_WAITING && state.isConnected && Object.keys(ROLE_CONFIG_CLIENT).includes(String(gameState.players.length));
    const canAddBot = state.isHost && gameState.game_state === STATE_WAITING && gameState.players.length < MAX_PLAYERS && state.isConnected;
    $('#start-btn').toggle(state.isHost && gameState.game_state === STATE_WAITING).prop('disabled', !canStart)
      .text(canStart ? '开始游戏' : `人数${gameState.players.length}不支持`);
    $('#add-bot-btn').toggle(canAddBot).prop('disabled', !canAddBot);

    if ([STATE_WAITING, STATE_OVER].includes(gameState.game_state)) clearActionArea();
    $('#chat-message, #send-chat-btn').prop('disabled', !state.isConnected);
  }

  function renderPlayerList(players) {
    const playerList = $('#player-list').empty();
    players.sort((a, b) => (a.is_bot !== b.is_bot ? a.is_bot - b.is_bot : a.username.localeCompare(b.username)))
      .forEach(p => {
        const selfClass = p.is_self ? 'self' : '', deadClass = !p.alive ? 'dead' : '';
        const hostIcon = p.is_host ? (p.is_bot ? '🤖' : '⭐') : '';
        if (p.is_self && p.is_host) state.isHost = true;
        playerList.append(`<div class="player-entry ${selfClass} ${deadClass}" data-sid="${p.sid}">
          <span>${hostIcon} ${p.username}</span>
          <span class="player-role-tag">[${p.role || '等待'}]</span>
        </div>`);
      });
  }

  function renderPromptAction(data) {
    clearActionArea();
    if (!state.roomCode || !data) return;
    // 死人禁操作
    if ((!state.isAlive && data.action_type !== 'shoot') || (data.action_type === 'vote' && !state.canVote)) {
      $('#action-prompt').html(data.message + " (你已出局或无权操作)");
      if (data.timeout && data.timeout > 0) startTimer(data.timeout);
      return;
    }
    $('#action-prompt').html(data.message || '');
    if (data.timeout && data.timeout > 0) startTimer(data.timeout);

    if (data.targets && Array.isArray(data.targets)) {
      data.targets.forEach(target => {
        if ((['vote', 'check'].includes(data.action_type)) && state.sid && target.sid === state.sid) return;
        if (data.action_type === 'link_2' && state.cupidFirstLover && target.sid === state.cupidFirstLover) return;
        const btnClass = target.sid === 'SKIP' ? 'action-skip-btn warn-btn' : 'action-player-btn';
        $('#action-buttons').append(
          `<button class="${btnClass}" data-action="${data.action_type}" data-target-sid="${target.sid}" ${state.isConnected ? '' : 'disabled'}>${target.name}</button>`
        );
      });
    }
    scrollMessages();
  }

  function startTimer(duration) {
    clearInterval(state.timerInterval);
    state.countdown = duration;
    $('#timer-display').text(`(${state.countdown}s)`).css('color', 'var(--gold-accent)');
    state.timerInterval = setInterval(() => {
      state.countdown--;
      if (state.countdown <= 5) $('#timer-display').css('color', 'var(--deep-red)');
      if (state.countdown > 0) $('#timer-display').text(`(${state.countdown}s)`);
      else {
        clearInterval(state.timerInterval);
        $('#timer-display').text(' (时间到!)');
        $('#action-buttons button').prop('disabled', true);
      }
    }, 1000);
  }

  // --- UI & 业务事件处理 ---
  $('#refresh-list-btn').click(() => {
    if (state.isConnected) {
      socket.emit('request_room_list');
      $('#room-list tbody').html('<tr><td colspan="5">刷新中...</td></tr>');
    }
  });
  $('#create-btn').click(() => {
    const username = getUsername();
    if (!username) return;
    const roomName = $('#room-name').val().trim() || `${username}的房间`;
    socket.emit('create_room', { username, room_name: roomName.replace(/</g, "&lt;"), password: $('#create-password').val() });
  });
  $('#join-btn').click(() => joinHandler($('#join-code').val().trim(), $('#join-password').val()));
  $('#quick-join-btn').click(() => joinHandler($('#quick-join-code').val().trim(), null));
  $('#leave-btn').click(() => {
    if (confirm("确定要离开房间吗？")) {
      state.roomCode = null;
      clearActionArea();
      if (state.isConnected) socket.emit('leave_room');
      else switchView('#lobby-view');
    }
  });
  $('#start-btn').click(() => { if (state.isHost && state.isConnected) socket.emit('start_game'); });
  $('#add-bot-btn').click(() => { if (state.isHost && state.isConnected) socket.emit('add_bot'); });
  $('#send-chat-btn').click(sendChat);
  $('#chat-message').keypress(event => { if (event.which == 13 && !event.shiftKey) { sendChat(); event.preventDefault(); } });

  $(document).on('click', '.join-public-btn', function () {
    const username = getUsername();
    if (!username) return;
    const code = $(this).data('code');
    const hasPassword = $(this).data('password');
    let password = "";
    if (hasPassword) {
      password = prompt("该房间需要密码,请输入:");
      if (password === null) return;
    }
    socket.emit('join_room', { username, room_code: code, password });
  });

  function joinHandler(code, password) {
    const username = getUsername();
    if (!username) return;
    if (!code) return showError("请输入房间码！");
    socket.emit('join_room', { username, room_code: code, password: password || "" });
  }

  function sendChat() {
    if (!state.isConnected) return;
    const msg = $('#chat-message').val().trim();
    if (msg && state.roomCode) {
      socket.emit('send_chat', { msg });
      $('#chat-message').val('');
    }
  }

  $(document).on('click', '.action-player-btn, .action-skip-btn', function () {
    if (state.countdown <= 0 && !state.timerInterval && state.countdown !== undefined) return; // Timer expired
    if (!state.isConnected) return;
    const action = $(this).data('action');
    const targetSid = $(this).data('target-sid');
    $('#action-buttons button').removeClass('selected');
    $(this).addClass('selected');
    // 丘比特特殊处理
    if (action === 'link_1') {
      state.cupidFirstLover = targetSid;
      socket.emit('game_action', { action_type: action, target_sid: targetSid });
      $('#action-buttons').empty();
      $('#action-prompt').html('请选择第二位情侣:');
    } else {
      if (action && targetSid) socket.emit('game_action', { action_type: action, target_sid: targetSid });
    }
  });

  // 全局弹窗关闭
  $('.close-button, .modal').click(function (event) {
    if ($(event.target).is('.close-button') || $(event.target).is('#error-popup')) {
      $('#error-popup').fadeOut(200);
    }
  });

  // 页面初始化
  $('#username').val(localStorage.getItem('username') || '');
  $('#quick-join-code').val(localStorage.getItem('last_room_code') || '');
  switchView('#lobby-view');
  updateConnectionStatus(false);
});
