
  const pcs = {};
  let lastSentMessage = "";

  // Параметры из URL
  const urlParams = new URLSearchParams(window.location.search);
  const roomId = urlParams.get('room') || "default";
  const myId = urlParams.get('user') || Math.random().toString(36).substr(2, 9);
  const userName = urlParams.get('name') ||  myId.substr(0,4);

  document.getElementById("roomId").textContent = roomId;
  document.getElementById("myId").textContent = userName;

  // Мапа userId → userName
  const userMap = {};
  userMap[myId] = userName;

  // Элементы DOM
  const localVideo = document.getElementById("localVideo");
  const remoteVideosContainer = document.getElementById("remoteVideosContainer");
  const usersList = document.getElementById("usersList");
  const statusText = document.getElementById("statusText");

  const startBtn = document.getElementById("startBtn");
  const toggleMicBtn = document.getElementById("toggleMicBtn");
  const toggleCamBtn = document.getElementById("toggleCamBtn");
  const screenBtn = document.getElementById("screenBtn");
  const recordBtn = document.getElementById("recordBtn");
  const stopBtn = document.getElementById("stopBtn");
  const downloadLink = document.getElementById("downloadLink");

  const chatMessages = document.getElementById("chatMessages");
  const chatInput = document.getElementById("chatInput");
  const sendChatBtn = document.getElementById("sendChatBtn");
  const fileInput = document.getElementById("fileInput");
  const imageInput = document.getElementById("imageInput");

  // WebRTC и WebSocket
  const rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
  const ws = new WebSocket(`ws://${location.host}/ws/${roomId}/${myId}`);

  const peerConnections = {};

  let localStream;
  let mediaRecorder;
  let recordedChunks = [];

  // Функция для вывода сообщений в чат
  function addChatMessage(text, fromSelf = false, isFile = false, fileUrl = '', senderName = '', isImage = false) {
  const div = document.createElement("div");
  div.style.fontWeight = fromSelf ? "bold" : "normal";

  if (isFile && isImage) {
    const img = document.createElement("img");
    img.src = fileUrl;
    img.style.maxWidth = "100%";
    img.style.maxHeight = "200px";
    div.appendChild(document.createTextNode(fromSelf ? "Вы отправили изображение: " : `Изображение от ${senderName}: `));
    div.appendChild(img);
  } else if (isFile) {
    const link = document.createElement("a");
    link.href = fileUrl;
    link.target = "_blank";
    link.textContent = text;
    div.appendChild(document.createTextNode(fromSelf ? "Вы отправили файл: " : `Файл от ${senderName}: `));
    div.appendChild(link);
  } else {
    div.textContent = fromSelf ? `Вы: ${text}` : `${senderName}: ${text}`;
  }

  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}


  // Управление удалёнными видео
  function addRemoteVideo(userId, stream) {
  let videoElem;

  // Если первый внешний пользователь — выводим в #secondScreen
  if (!document.getElementById("secondScreen").srcObject) {
    videoElem = document.getElementById("secondScreen");
  } else {
    videoElem = document.getElementById("remoteVideo-" + userId);
    if (!videoElem) {
      videoElem = document.createElement("video");
      videoElem.id = "remoteVideo-" + userId;
      videoElem.autoplay = true;
      videoElem.playsInline = true;
      videoElem.style.width = "200px";
      videoElem.style.border = "1px solid #ccc";
      videoElem.style.margin = "5px";
      remoteVideosContainer.appendChild(videoElem);
    }
  }

  videoElem.srcObject = stream;
}


  function removeRemoteVideo(userId) {
    const videoElem = document.getElementById("remoteVideo-" + userId);
    if (videoElem) {
      videoElem.srcObject = null;
      videoElem.remove();
    }
  }

  // Обновление списка участников и авто-соединение
  // Ожидается что сервер присылает msg.users = [{id: ..., name: ...}, ...]
  function updateUsers(users) {
  usersList.innerHTML = "";
  const isAdmin = myId === "1"; // первый вошедший — админ

  users.forEach(({id, name}) => {
    userMap[id] = name || id || "User";

    const userDiv = document.createElement("div");
    userDiv.className = "user";
    userDiv.textContent = userMap[id];

    // Кнопки кик и мут для админа (кроме самого себя)
    if (isAdmin && id !== myId) {
      const kickBtn = document.createElement("button");
      kickBtn.textContent = "Кик";
      kickBtn.style.marginLeft = "10px";
      kickBtn.onclick = () => {
        // Отправляем сообщение серверу с командой кика пользователя
        ws.send(JSON.stringify({
          type: "kick_user",
          target_id: id,
          sender_id: myId
        }));
      };

      const muteBtn = document.createElement("button");
      muteBtn.textContent = "Мут";
      muteBtn.style.marginLeft = "5px";
      // Пока без реализации, просто кнопка
      muteBtn.onclick = () => {
        alert(`Пользователь ${userMap[id]} был бы замучен 🙂`);
      };

      userDiv.appendChild(kickBtn);
      userDiv.appendChild(muteBtn);
    }

    usersList.appendChild(userDiv);
  });
}



  // Запуск камеры
  startBtn.onclick = async () => {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
      statusText.textContent = "📷 Камера включена";

      toggleMicBtn.disabled = false;
      toggleCamBtn.disabled = false;
      toggleMicBtn.textContent = "Выкл Микрофон";
      toggleCamBtn.textContent = "Выкл Камера";
    } catch (err) {
      alert("Ошибка доступа к камере и микрофону: " + err.message);
    }
  };

  // Вкл/выкл микрофон
  toggleMicBtn.onclick = () => {
    if (!localStream) return;
    localStream.getAudioTracks().forEach(track => track.enabled = !track.enabled);
    toggleMicBtn.textContent = localStream.getAudioTracks()[0].enabled ? "Выкл Микрофон" : "Вкл Микрофон";
  };

  // Вкл/выкл камеру
  toggleCamBtn.onclick = () => {
    if (!localStream) return;
    localStream.getVideoTracks().forEach(track => track.enabled = !track.enabled);
    toggleCamBtn.textContent = localStream.getVideoTracks()[0].enabled ? "Выкл Камера" : "Вкл Камера";
  };

  // Демонстрация экрана
  // Демонстрация экрана с явным renegotiation
screenBtn.onclick = async () => {
  try {
    // 1) Захват экрана
    const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });

    // 2) Добавляем track экрана во все RTCPeerConnection
    for (const [targetId, pc] of Object.entries(peerConnections)) {
      const screenTrack = screenStream.getVideoTracks()[0];
      const sender = pc.addTrack(screenTrack, screenStream);
      console.log("Отправляем экран: sender=", sender, "для", targetId);

      // 3) При окончании демонстрации — удаляем трек и пересогласовываем
      screenTrack.onended = async () => {
        pc.removeTrack(sender);
        console.log("Экран завершён, удаляем трек и renegotiate для", targetId);

        const offer2 = await pc.createOffer();
        await pc.setLocalDescription(offer2);
        ws.send(JSON.stringify({
          type: "webrtc_offer",
          offer: offer2,
          target_id: targetId,
          sender_id: myId
        }));

        // вернуть локальную камеру
        localVideo.srcObject = localStream;
      };
    }

    // 4) Показать экран локально
    localVideo.srcObject = screenStream;

    // 5) Запустить первое renegotiation для всех peerConnections
    for (const [targetId, pc] of Object.entries(peerConnections)) {
      console.log("→ Renegotiate offer после установки локального экрана для", targetId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({
        type: "webrtc_offer",
        offer,
        target_id: targetId,
        sender_id: myId
      }));
    }

  } catch (err) {
    alert("Ошибка при демонстрации экрана: " + err.message);
  }
};



  // Запись видео
  recordBtn.onclick = () => {
    const stream = remoteVideosContainer.querySelector("video")?.srcObject;
    if (!stream) {
      alert("Нет активного видео для записи.");
      return;
    }
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: "video/webm" });

    mediaRecorder.ondataavailable = e => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: "video/webm" });
      const url = URL.createObjectURL(blob);
      downloadLink.href = url;
      downloadLink.download = `recording-${Date.now()}.webm`;
      downloadLink.style.display = "inline-block";
      statusText.textContent = "Запись остановлена, файл готов для скачивания.";
    };

    mediaRecorder.start();
    statusText.textContent = "🔴 Запись началась...";
    recordBtn.disabled = true;
    stopBtn.disabled = false;
  };

  stopBtn.onclick = () => {
    if (mediaRecorder) {
      mediaRecorder.stop();
      recordBtn.disabled = false;
      stopBtn.disabled = true;
    }
  };

  // Начать вызов с другим пользователем
  async function startCall(targetId) {
    if (peerConnections[targetId]) {
  const pc = peerConnections[targetId];
  if (pc.signalingState !== "stable") {
    console.warn(`⏳ Пропускаем startCall для ${targetId}, т.к. signalingState =`, pc.signalingState);
    return;
  }

  console.log(`Соединение с ${targetId} уже установлено`);
  return;
}

    const pc = new RTCPeerConnection(rtcConfig);
    peerConnections[targetId] = pc;

    if (localStream) {
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    pc.onicecandidate = e => {
      if (e.candidate) {
        console.log("→ new ICE candidate", e.candidate);
        ws.send(JSON.stringify({
          type: "ice_candidate",
          candidate: e.candidate,
          target_id: targetId,
          sender_id: myId
        }));
      }
    };

    pc.ontrack = async e => {
  const stream = e.streams[0];
  const videoTracks = stream.getVideoTracks();
  const audioTracks = stream.getAudioTracks();

  console.log("!! ontrack", "from", targetId, "videoTracks=", videoTracks.length, "audioTracks=", audioTracks.length);

  // Если это экран (видео без аудио)
  if (videoTracks.length === 1 && audioTracks.length === 0) {
    const secondScreen = document.getElementById("secondScreen");
    console.log("→ ontrack: this IS screen, assigning to secondScreen:", stream);

    secondScreen.srcObject = stream;

    setTimeout(() => {
        console.log("secondScreen.readyState:", secondScreen.readyState);
        console.log("secondScreen.paused:", secondScreen.paused);
        console.log("secondScreen.srcObject tracks:", secondScreen.srcObject?.getVideoTracks());
      }, 300);

    // Попытка безопасного воспроизведения
    const attemptPlay = async () => {
      try {
        // Ждём пока появится трек
        await new Promise(resolve => setTimeout(resolve, 100));
        await secondScreen.play();
        console.log("▶ secondScreen started successfully");
      } catch (err) {
        console.warn("❌ Не удалось автозапустить secondScreen:", err);
        // Просим пользователя кликнуть
        secondScreen.onclick = async () => {
          try {
            await secondScreen.play();
            console.log("▶ secondScreen started after manual click");
          } catch (manualErr) {
            console.error("❌ Manual play failed:", manualErr);
          }
        };
        statusText.textContent = "⚠️ Нажмите на экран для воспроизведения трансляции";
      }
    };

    attemptPlay();

    statusText.textContent = `🖥 Демонстрация экрана от ${userMap[targetId] || targetId}`;
  } else {
    addRemoteVideo(targetId, stream);
    statusText.textContent = `📡 Видео от ${userMap[targetId] || targetId}`;
  }
};






    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      statusText.textContent = `ICE connection state с ${userMap[targetId] || targetId}: ${state}`;
      if (state === "failed" || state === "disconnected" || state === "closed") {
        alert(`Соединение с ${userMap[targetId] || targetId} потеряно (${state})`);
        removeRemoteVideo(targetId);
        if (peerConnections[targetId]) {
          peerConnections[targetId].close();
          delete peerConnections[targetId];
        }
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    ws.send(JSON.stringify({
      type: "webrtc_offer",
      offer,
      target_id: targetId,
      sender_id: myId
    }));
  }

  // Отправка чат-сообщения
  function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text) return;

    lastSentMessage = text;

    addChatMessage(text, true, false, '', userName);
    ws.send(JSON.stringify({
      type: "chat_message",
      message: text,
      sender_id: myId,
      sender_name: userName
    }));
    chatInput.value = "";
  }

  sendChatBtn.onclick = sendChatMessage;
  chatInput.onkeydown = e => {
    if (e.key === "Enter") sendChatMessage();
  };

  // Передача файлов
fileInput.onchange = () => {
  const file = fileInput.files[0];
  if (!file) return;

  const reader = new FileReader();

  reader.onload = () => {
    const base64Data = reader.result.split(',')[1]; // base64 без префикса

    ws.send(JSON.stringify({
      type: "file_transfer",
      filename: file.name,
      filetype: file.type,
      data: base64Data,
      sender_id: myId,
      sender_name: userName,
      target_id: null
    }));

    // Создаём локальный URL из Blob для отображения ссылки в чате
    const blob = new Blob([file], { type: file.type });
    const url = URL.createObjectURL(blob);

    addChatMessage(`Файл отправлен: ${file.name}`, true, true, url);
  };

  reader.readAsDataURL(file);
  fileInput.value = "";
};


  imageInput.onchange = () => {
    const file = imageInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const data = reader.result.split(',')[1];
      ws.send(JSON.stringify({
        type: "image_transfer",
        filename: file.name,
        filetype: file.type,
        data: data,
        sender_id: myId,
        sender_name: userName
      }));
      addChatMessage("Изображение отправлено", true, true, reader.result, userName, true);
    };
    reader.readAsDataURL(file);
    imageInput.value = "";
  };

  // Обработка сообщений от сервера
  ws.onmessage = async e => {
    const msg = JSON.parse(e.data);

    console.log("<< WS message:", msg);


    if (msg.type === "kicked") {
    alert("Вы были кикнуты администратором");
    window.location.href = "/lobby.html";
    return;
  }

    if (msg.type === "user_joined") {
      // Ожидается msg.users = [{id, name}, ...]
      updateUsers(msg.users);
      addChatMessage(`Пользователь ${msg.user_id} (${msg.user_name || ''}) присоединился`, false);
      return;
    }
    if (msg.type === "user_left") {
      updateUsers(msg.users);
      addChatMessage(`Пользователь ${msg.user_id} (${msg.user_name || ''}) покинул комнату`, false);
      removeRemoteVideo(msg.user_id);
      if (peerConnections[msg.user_id]) {
        peerConnections[msg.user_id].close();
        delete peerConnections[msg.user_id];
      }
      return;
    }

    if (!msg.sender_id) return;


    if (msg.type === "chat_message") {
      const senderName = msg.sender_name || userMap[msg.sender_id] || msg.sender_id;
      if (msg.sender_id === myId && msg.message === lastSentMessage) {
        lastSentMessage = "";  // сбрасываем, чтобы следующая проверка сработала
        return;
      }
      addChatMessage(msg.message, false, false, '', senderName);
    } else if (msg.type === "file_transfer") {
      const base64Data = msg.data;
      const contentType = msg.filetype || "application/octet-stream";


      // Декодируем base64 в байты
      const byteCharacters = atob(base64Data);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);

      // Создаём Blob и URL для скачивания
      const blob = new Blob([byteArray], {type: contentType});
      const url = URL.createObjectURL(blob);

      addChatMessage(
              msg.filename,
              false,
              true,
              url,
              msg.sender_name || userMap[msg.sender_id] || msg.sender_id
      );
    } else if (msg.type === "image_transfer") {
      const base64Data = msg.data;
      const contentType = msg.filetype || "application/octet-stream";

      // Декодируем base64 в байты
      const byteCharacters = atob(base64Data);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);

      // Создаём Blob и URL для изображения
      const blob = new Blob([byteArray], {type: contentType});
      const url = URL.createObjectURL(blob);

      // Передаем isImage = true!
      addChatMessage(
              "Изображение",
              false,
              true,
              url,
              msg.sender_name || userMap[msg.sender_id] || msg.sender_id,
              true  // <-- ВАЖНО: указываем, что это изображение
      );
    }
    else if (msg.type === "webrtc_offer") {
  const fromId = msg.sender_id;
  const offer = msg.offer;

  let pc = peerConnections[fromId];
  if (!pc) {
    pc = new RTCPeerConnection(rtcConfig);
    peerConnections[fromId] = pc;
    setupPeerConnection(pc, fromId); // добавление обработчиков
    function setupPeerConnection(pc, remoteId) {
  pc.ontrack = (event) => {
    console.log("!! ontrack from", remoteId, "videoTracks=", event.streams[0]?.getVideoTracks().length, "audioTracks=", event.streams[0]?.getAudioTracks().length);

    const stream = event.streams[0];
    secondScreen.srcObject = stream;
    console.log("→ ontrack: this IS screen, assigning to secondScreen:", stream);
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({
        type: "webrtc_ice_candidate",
        candidate: event.candidate,
        target_id: remoteId,
        sender_id: myId
      }));
    }
  };
}

  }

  console.log("<< Получен offer от", fromId);

  const polite = myId > fromId;
  const makingOffer = pc.signalingState !== "stable";

  try {
    if (makingOffer) {
      console.warn("⚠️ Glare от", fromId, ". Мы вежливые — делаем rollback");
      await pc.setLocalDescription({ type: "rollback" });
    }

    await pc.setRemoteDescription(new RTCSessionDescription(offer));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    ws.send(JSON.stringify({
      type: "webrtc_answer",
      answer,
      target_id: fromId,
      sender_id: myId
    }));

  } catch (err) {
    console.error("❌ Ошибка при обработке offer:", err);
  }
}

      else if (msg.type === "webrtc_answer") {
      const fromId = msg.sender_id;
      const answer = new RTCSessionDescription(msg.answer);

      const pc = peerConnections[fromId];
    }

      else if (msg.type === "webrtc_answer") {
  const fromId = msg.sender_id;
  const answer = new RTCSessionDescription(msg.answer);
  const pc = peerConnections[fromId];

  if (!pc) {
    console.warn("Нет соединения для", fromId);
    return;
  }

  try {
    // Даже если состояние уже stable — мы все равно пытаемся применить ответ
    // Это нужно для Perfect Negotiation, когда offer/answer могут перекрываться
    await pc.setRemoteDescription(answer);

    // Добавляем отложенные ICE-кандидаты (если есть)
    if (pc._queuedCandidates) {
      for (const c of pc._queuedCandidates) {
        await pc.addIceCandidate(c);
      }
      pc._queuedCandidates = [];
    }

    console.log("✅ Установлен remote answer от", fromId);
  } catch (err) {
    console.warn(`⚠️ Невозможно установить remote answer:`, err, "Текущее состояние:", pc.signalingState);
  }
}



     else if (msg.type === "webrtc_ice_candidate") {
      const fromId = msg.sender_id;
      const candidate = new RTCIceCandidate(msg.candidate);
      const pc = peerConnections[fromId];

      try {
        if (!pc) {
          console.warn("❗ Нет соединения для ICE-кандидата от", fromId);
          return;
        }

        if (pc.remoteDescription) {
          await pc.addIceCandidate(candidate);
          console.log("✅ Добавлен ICE-кандидат от", fromId);
        } else {
          // отложим кандидатов, если remoteDescription ещё не установлено
          if (!pc._queuedCandidates) {
            pc._queuedCandidates = [];
          }
          pc._queuedCandidates.push(candidate);
          console.log("📥 Отложен ICE-кандидат от", fromId);
        }
      } catch (err) {
        console.error("❌ Ошибка при добавлении ICE-кандидата:", err);
      }
    }

    else if (msg.type === "users_list") {
      // Обновление списка участников с никами
      updateUsers(msg.users);
    }
  };

  ws.onopen = () => {
    statusText.textContent = "🟢 WebSocket соединение установлено";
    // Отправим серверу свой ник для обновления списка
    ws.send(JSON.stringify({
      type: "join",
      user_id: myId,
      user_name: userName
    }));
  };

  ws.onclose = () => {
    statusText.textContent = "🔴 WebSocket соединение закрыто";
  };

  ws.onerror = err => {
    console.error("WebSocket ошибка", err);
    statusText.textContent = "❌ WebSocket ошибка";
  };
  function kickUser(targetId) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "kick_user",
      target_id: targetId
    }));
  }
}