// static/client.js
$(document).ready(function () {
  // @ts-ignore
  const socket = io({ timeout: 10000, reconnectionAttempts: 5 });
  let myRoomCode = null;
  let myUsername = null;
  let mySID = null;
  let amIHost = false;
  let amIAlive = true;
  let canIVote = true;
  let actionTimerInterval = null;
  let isConnected = false;
  let cupidFirstLover = null; // Track cupid's first selection

  // SYNC WITH BACKEND main.ts
  const MAX_PLAYERS_CLIENT = 12;
  const MIN_PLAYERS_CLIENT = 6;
  const STATE_WAITING = "等待中";
  const STATE_OVER = "已结束";

  function switchView(viewId) {
    console.log("Switching view to:", viewId);
    $('.view').removeClass('active-view');
    $(viewId).addClass('active-view');
    if (viewId === '#lobby-view') {
      myRoomCode = null;
      amIHost = false;
      amIAlive = true;
      canIVote = true;
      cupidFirstLover = null;
      $('#messages, #player-list, #action-buttons').empty();
      $('#my-role-info').html('你的身份: <strong>等待中</strong>');
      $('#winner-banner').text('').hide();
      $('#start-btn, #add-bot-btn').hide();
      clearActionArea();
      if (isConnected) socket.emit('request_room_list');
    }
    scrollMessages();
  }

  function showError(message, title = "提示") {
    console.warn("Showing Message:", title, message);
    $('#error-title').text(title);
    $('#error-message-text').html(message);
    $('#error-popup').fadeIn(200);
  }

  $('.close-button, .modal').click(function (event) {
    if ($(event.target).is('.close-button') || $(event.target).is('#error-popup')) {
      $('#error-popup').fadeOut(200);
    }
  });

  function getUsername() {
    myUsername = $('#username').val().trim();
    if (!isConnected) {
      showError("服务器连接失败或已断开，无法操作。");
      return null;
    }
    if (!myUsername) {
      showError("请输入昵称！");
      return null;
    }
    myUsername = myUsername.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    localStorage.setItem('username', myUsername);
    return myUsername;
  }

  $('#username').val(localStorage.getItem('username') || '');
  $('#quick-join-code').val(localStorage.getItem('last_room_code') || '');

  function updateConnectionStatus(connected) {
    isConnected = connected;
    const statusEl = $('#connection-status');
    $('#chat-message, #send-chat-btn, #create-btn, #join-btn, #refresh-list-btn, #quick-join-btn').prop('disabled', !isConnected);
    if (connected) {
      statusEl.text('已连接服务器').css('color', 'lightgreen');
      setTimeout(() => statusEl.text(''), 2000);
    } else {
      statusEl.text('未连接服务器 / 正在重连...').css('color', 'var(--deep-red)');
    }
  }

  // --- Socket Events ---
  socket.on('connect', () => {
    updateConnectionStatus(true);
    mySID = socket.id;
    console.log("✅ Socket Connected with SID:", mySID);
    if (myRoomCode === null) socket.emit('request_room_list');
  });

  socket.on('connect_error', (err) => {
    updateConnectionStatus(false);
    console.error("❌ Socket Connection Error:", err);
    showError(`无法建立连接。<br/>错误: ${err.message}`, "连接错误");
  });

  socket.io.on("reconnect_attempt", () => updateConnectionStatus(false));

  socket.io.on("reconnect_failed", () => {
    showError(`连接重建失败。请刷新页面。`, "连接失败");
  });

  socket.on('disconnect', (reason) => {
    updateConnectionStatus(false);
    console.warn("❌ Socket Disconnected. Reason:", reason);
    showError(`与服务器的连接已断开。原因: ${reason}`, "连接断开");
    clearActionArea();
    if (myRoomCode) switchView('#lobby-view');
  });

  socket.on('error_message', data => {
    showError(data.msg || '未知错误', "服务器错误");
  });

  socket.on('room_list', rooms => {
    const list = $('#room-list tbody');
    list.empty();
    updateConnectionStatus(isConnected);

    if (!isConnected) {
      list.append('<tr><td colspan="5" style="color: var(--deep-red);">连接失败。</td></tr>');
      return;
    }

    if (!rooms || rooms.length === 0) {
      list.append('<tr><td colspan="5">当前没有开放的房间。</td></tr>');
      return;
    }

    rooms.sort((a, b) => a.name.localeCompare(b.name));
    rooms.forEach(room => {
      const lock = room.has_password ? '🔒' : '🔓';
      const canJoin = room.state === 'WAITING' && isConnected && room.players < room.max_players;
      const joinButtonHTML = `<button class="join-public-btn" data-code="${room.code}" data-password="${room.has_password}">加入</button>`;
      let actionCol = canJoin ? joinButtonHTML : (room.players >= room.max_players ? '人满' : '进行中');
      if (!isConnected) actionCol = '未连接';
      list.append(`<tr><td>${room.name}</td><td>${room.code}</td><td>${room.players}/${room.max_players}</td><td>${lock}</td><td>${actionCol}</td></tr>`);
    });
  });

  socket.on('join_success', data => {
    myRoomCode = data.room_code;
    localStorage.setItem('last_room_code', myRoomCode);
    switchView('#room-view');
    $('#messages, #action-buttons').empty();
    $('#winner-banner').text('').hide();
    clearActionArea();
  });

  socket.on('leave_success', () => {
    console.log("Leave success confirmed");
    switchView('#lobby-view');
  });

  socket.on('update_state', state => {
    if (!state || !myRoomCode) return;
    console.log("Update State:", state.game_state);

    const playerCount = state.players ? state.players.length : 0;
    amIAlive = state.am_i_alive;
    canIVote = state.can_vote; // For idiot

    $('#room-title').text(`房间: ${state.room_name} (代码: ${state.room_code})`);
    $('#player-count').text(`${playerCount}/${MAX_PLAYERS_CLIENT}`);
    $('#game-state-display').text(state.game_state);
    $('#host-name').text(state.host_username || '无');

    if (state.winner) {
      const banner = $('#winner-banner');
      banner.text(`🎉 恭喜 ${state.winner} 获得胜利！ 🎉`).slideDown();
      // Adjust color based on winner
      if (state.winner.includes('狼人')) banner.css({ 'background-color': 'var(--wolf-red)', 'border-color': 'white' });
      else if (state.winner.includes('情侣')) banner.css({ 'background-color': '#FF69B4', 'border-color': 'white' }); // Pink
      else banner.css({ 'background-color': '#4CAF50', 'border-color': 'var(--gold-accent)' }); // Green
    } else {
      $('#winner-banner').slideUp();
    }

    const playerList = $('#player-list');
    playerList.empty();
    amIHost = false;
    if (state.players && Array.isArray(state.players)) {
      state.players.sort((a, b) => {
        if (a.is_bot !== b.is_bot) return a.is_bot ? 1 : -1;
        return a.username.localeCompare(b.username);
      })
        .forEach(p => {
          const selfClass = p.is_self ? 'self' : '';
          const deadClass = !p.alive ? 'dead' : '';
          const hostIcon = p.is_host ? (p.is_bot ? '🤖' : '⭐') : '';
          if (p.is_self && p.is_host) amIHost = true; // Fixed: only set amIHost if is_self AND is_host
          // Username now includes (AI) and status icons ❤️🤪 from server
          playerList.append(`<div class="player-entry ${selfClass} ${deadClass}" data-sid="${p.sid}">
          <span>${hostIcon} ${p.username}</span>
          <span class="player-role-tag">[${p.role || '等待'}]</span>
        </div>`);
        });
    }

    if (state.my_role) {
      $('#my-role-info').html(`你的身份: <strong>${state.my_role}</strong> ${state.is_lover ? '❤️' : ''}<br><small>${state.my_role_desc || ''}</small>`);
    } else {
      $('#my-role-info').html('你的身份: <strong>等待中</strong>');
    }

    // Client-side config check for start button msg
    const ROLE_CONFIG_CLIENT = { 6: {}, 8: {}, 10: {}, 12: {} }; // Sync with backend configs

    const canStart = amIHost && state.game_state === STATE_WAITING && isConnected && Object.keys(ROLE_CONFIG_CLIENT).includes(String(playerCount));
    const canAddBot = amIHost && state.game_state === STATE_WAITING && playerCount < MAX_PLAYERS_CLIENT && isConnected;

    // Debug log
    console.log('Button visibility debug:', {
      amIHost,
      gameState: state.game_state,
      isWaiting: state.game_state === STATE_WAITING,
      playerCount,
      MAX_PLAYERS_CLIENT,
      isConnected,
      canAddBot,
      canStart
    });

    if (canStart) $('#start-btn').text('开始游戏');
    else if (amIHost && state.game_state === STATE_WAITING && !Object.keys(ROLE_CONFIG_CLIENT).includes(String(playerCount))) {
      $('#start-btn').text(`人数 ${playerCount} 不支持`);
    } else {
      $('#start-btn').text('开始游戏');
    }

    $('#start-btn').toggle(amIHost && state.game_state === STATE_WAITING).prop('disabled', !canStart);
    $('#add-bot-btn').toggle(canAddBot).prop('disabled', !canAddBot);

    // Temporary fix: Force show button if you're host in waiting state
    if (amIHost && state.game_state === STATE_WAITING && playerCount < MAX_PLAYERS_CLIENT) {
      $('#add-bot-btn').show().prop('disabled', false);
      console.log('Force showing add bot button');
    }

    if ([STATE_WAITING, STATE_OVER].includes(state.game_state)) clearActionArea();
    $('#chat-message, #send-chat-btn').prop('disabled', !isConnected);
  });

  function scrollMessages() {
    const msgDiv = $('#messages');
    const isNearBottom = msgDiv.scrollTop() + msgDiv.innerHeight() >= msgDiv[0].scrollHeight - 50;
    if (msgDiv.length > 0 && isNearBottom) msgDiv.scrollTop(msgDiv[0].scrollHeight);
  }

  socket.on('game_message', data => {
    if (!data || !myRoomCode) return;
    const messages = $('#messages');
    const msgClass = `msg-${data.type || 'system'}`;
    const sender = data.sender ? `<span class="sender">${data.sender}:</span> ` : '';
    const messageContent = (data.msg || '').replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, '<br>');
    messages.append(`<div class="msg ${msgClass}"><p>${sender}${messageContent}</p></div>`);
    scrollMessages();
  });

  let countdown;
  function startTimer(duration) {
    clearInterval(actionTimerInterval);
    actionTimerInterval = null;
    if (duration <= 0) {
      $('#timer-display').text('');
      return;
    }
    countdown = duration;
    $('#timer-display').text(`(${countdown}s)`).css('color', 'var(--gold-accent)');
    actionTimerInterval = setInterval(() => {
      countdown--;
      if (countdown <= 5) $('#timer-display').css('color', 'var(--deep-red)');
      if (countdown > 0) {
        $('#timer-display').text(`(${countdown}s)`);
      } else {
        clearInterval(actionTimerInterval);
        actionTimerInterval = null;
        $('#timer-display').text(' (时间到!)');
        $('#action-buttons button').prop('disabled', true);
      }
    }, 1000);
  }

  function clearActionArea() {
    $('#action-prompt').text('');
    $('#action-buttons').empty();
    $('#timer-display').text('');
    clearInterval(actionTimerInterval);
    actionTimerInterval = null;
    cupidFirstLover = null; // Reset cupid state
  }

  socket.on('prompt_action', data => {
    console.log("Prompt Action:", data?.action_type);
    if (!myRoomCode) return;
    clearActionArea();
    if (!data) return;

    // Disable prompt if dead (except hunter shoot) or idiot cannot vote
    if ((!amIAlive && data.action_type !== 'shoot') || (data.action_type === 'vote' && !canIVote)) {
      $('#action-prompt').html(data.message + " (你已出局或无权操作)");
      if (data.timeout && data.timeout > 0) startTimer(data.timeout); // still show timer
      return;
    }

    $('#action-prompt').html(data.message || '');
    const buttonsDiv = $('#action-buttons');
    if (data.timeout && data.timeout > 0) startTimer(data.timeout);

    if (data.targets && Array.isArray(data.targets)) {
      data.targets.forEach(target => {
        // Client filters: no vote/check self. Server validates.
        if ((data.action_type === 'vote' || data.action_type === 'check') && mySID && target.sid === mySID) return;

        // Filter out first lover for link_2
        if (data.action_type === 'link_2' && cupidFirstLover && target.sid === cupidFirstLover) return;

        const btnClass = target.sid === 'SKIP' ? 'action-skip-btn warn-btn' : 'action-player-btn';
        const button = $(`<button class="${btnClass}" 
                                data-action="${data.action_type}" 
                                data-target-sid="${target.sid}" 
                                ${isConnected ? '' : 'disabled'}>
                             ${target.name}
                          </button>`);
        buttonsDiv.append(button);
      });
    }
    scrollMessages();
  });

  // --- UI Event Handlers ---
  $('#refresh-list-btn').click(() => {
    if (isConnected) {
      socket.emit('request_room_list');
      $('#room-list tbody').html('<tr><td colspan="5">刷新中...</td></tr>');
    }
  });

  $('#create-btn').click(() => {
    const username = getUsername();
    if (!username) return;
    const roomName = $('#room-name').val().trim() || `${username}的房间`;
    socket.emit('create_room', {
      username: username,
      room_name: roomName.replace(/</g, "&lt;"),
      password: $('#create-password').val()
    });
  });

  const joinHandler = (code, password) => {
    const username = getUsername();
    if (!username) return;
    if (!code) {
      showError("请输入房间码！");
      return;
    }
    socket.emit('join_room', {
      username: username,
      room_code: code,
      password: password || ""
    });
  };

  $('#join-btn').click(() => joinHandler($('#join-code').val().trim(), $('#join-password').val()));

  $('#quick-join-btn').click(() => joinHandler($('#quick-join-code').val().trim(), null));

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
    socket.emit('join_room', {
      username: username,
      room_code: code,
      password: password
    });
  });

  $('#leave-btn').click(() => {
    if (confirm("确定要离开房间吗？")) {
      myRoomCode = null;
      clearActionArea();
      if (isConnected) socket.emit('leave_room');
      else switchView('#lobby-view');
    }
  });

  $('#start-btn').click(() => {
    if (amIHost && isConnected) socket.emit('start_game');
  });

  $('#add-bot-btn').click(() => {
    if (amIHost && isConnected) {
      socket.emit('add_bot');
      // Don't disable immediately - let server response handle it
      console.log('Add bot button clicked');
    }
  });

  function sendChat() {
    if (!isConnected) return;
    const msg = $('#chat-message').val().trim();
    if (msg && myRoomCode) {
      socket.emit('send_chat', { msg: msg });
      $('#chat-message').val('');
    }
  }

  $('#send-chat-btn').click(sendChat);

  $('#chat-message').keypress(event => {
    if (event.which == 13 && !event.shiftKey) {
      sendChat();
      event.preventDefault();
    }
  });

  $(document).on('click', '.action-player-btn, .action-skip-btn', function () {
    if (countdown <= 0 && actionTimerInterval === null && countdown !== undefined) return; // Timer expired
    if (!isConnected) return;
    const action = $(this).data('action');
    const targetSid = $(this).data('target-sid'); // Can be player sid, role name, or 'SKIP'
    $('#action-buttons button').removeClass('selected');
    $(this).addClass('selected');
    console.log(`Action: ${action}, Target: ${targetSid}`);

    // Special handling for cupid link actions
    if (action === 'link_1') {
      cupidFirstLover = targetSid;
      // After selecting first lover, immediately prompt for second
      socket.emit('game_action', {
        action_type: action,
        target_sid: targetSid
      });

      // Clear current buttons and update prompt
      $('#action-buttons').empty();
      $('#action-prompt').html('请选择第二位情侣:');

      // Re-request targets for link_2 (server should send them)
      // Actually, server will handle this and send a new prompt
    } else {
      // Normal action handling
      if (action && targetSid) {
        socket.emit('game_action', {
          action_type: action,
          target_sid: targetSid
        });
        // Server responds with 'ai_private' message: '已选择: ...'
      }
    }
  });

  // Add a global function to manually show the add bot button (for debugging)
  window.showAddBotButton = function () {
    $('#add-bot-btn').show().prop('disabled', false);
    console.log('Manually showing add bot button');
  };

  switchView('#lobby-view');
  updateConnectionStatus(false);
});