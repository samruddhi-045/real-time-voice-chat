import React, { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const SOCKET_URL = "http://localhost:5000";

const ICE_SERVERS = {
  iceServers: [
    {
      urls: "stun:stun.l.google.com:19302",
    },
  ],
};

function App() {
  const params = new URLSearchParams(window.location.search);

  const [role, setRole] = useState(
    params.get("role") === "agent" ? "agent" : "customer"
  );

  const [socketConnected, setSocketConnected] = useState(false);
  const [joined, setJoined] = useState(false);

  const [callStatus, setCallStatus] = useState("Waiting for connection");
  const [callActive, setCallActive] = useState(false);

  const [isMuted, setIsMuted] = useState(false);
  const [callDuration, setCallDuration] = useState(0);

  const [messages, setMessages] = useState([]);
  const [messageText, setMessageText] = useState("");

  const [error, setError] = useState("");

  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);

  const remoteAudioRef = useRef(null);

  const callStartTimeRef = useRef(null);
  const durationIntervalRef = useRef(null);

  const pendingIceCandidatesRef = useRef([]);

  // ----------------------------------------------------
  // FORMAT TIME
  // ----------------------------------------------------

  const formatDuration = (seconds) => {
    const mins = Math.floor(seconds / 60)
      .toString()
      .padStart(2, "0");

    const secs = (seconds % 60)
      .toString()
      .padStart(2, "0");

    return `${mins}:${secs}`;
  };

  const formatMessageTime = (timestamp) => {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  // ----------------------------------------------------
  // CREATE WEBRTC CONNECTION
  // ----------------------------------------------------

  const createPeerConnection = () => {
    if (peerConnectionRef.current) {
      return peerConnectionRef.current;
    }

    const peerConnection = new RTCPeerConnection(ICE_SERVERS);

    console.log("WebRTC connection created");

    // Receive remote audio
    peerConnection.ontrack = (event) => {
      console.log("Remote audio received");

      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = event.streams[0];

        remoteAudioRef.current
          .play()
          .then(() => {
            console.log("Remote audio playing");
          })
          .catch((err) => {
            console.log(
              "Autoplay blocked. User must click Enable Audio.",
              err
            );
          });
      }
    };

    // ICE candidate
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        console.log("Sending ICE candidate");

        socketRef.current?.emit(
          "ice-candidate",
          event.candidate
        );
      }
    };

    // Connection state
    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;

      console.log("WebRTC state:", state);

      if (state === "connecting") {
        setCallStatus("Connecting...");
      }

      if (state === "connected") {
        setCallStatus("Connected");
        setCallActive(true);

        startCallTimer();
      }

      if (state === "disconnected") {
        setCallStatus("Disconnected");
      }

      if (state === "failed") {
        setCallStatus("Connection failed");
        setError("Voice connection failed.");
      }

      if (state === "closed") {
        setCallStatus("Call ended");
      }
    };

    // Add microphone if already available
    if (localStreamRef.current) {
      localStreamRef.current
        .getTracks()
        .forEach((track) => {
          peerConnection.addTrack(
            track,
            localStreamRef.current
          );
        });

      console.log("Microphone added to WebRTC");
    }

    peerConnectionRef.current = peerConnection;

    return peerConnection;
  };

  // ----------------------------------------------------
  // MICROPHONE
  // ----------------------------------------------------

  const getMicrophone = async () => {
    try {
      setError("");
      setCallStatus("Requesting microphone...");

      console.log("Requesting microphone access...");

      const stream =
        await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });

      localStreamRef.current = stream;

      console.log("Microphone access granted");

      if (peerConnectionRef.current) {
        const senders =
          peerConnectionRef.current.getSenders();

        stream.getTracks().forEach((track) => {
          const alreadyAdded = senders.some(
            (sender) => sender.track === track
          );

          if (!alreadyAdded) {
            peerConnectionRef.current.addTrack(
              track,
              stream
            );
          }
        });
      }

      setCallStatus("Microphone ready");

      return stream;
    } catch (err) {
      console.error("Microphone error:", err);

      setError(
        "Microphone access failed. Please allow microphone permission."
      );

      setCallStatus("Microphone unavailable");

      return null;
    }
  };

  // ----------------------------------------------------
  // START CALL TIMER
  // ----------------------------------------------------

  const startCallTimer = () => {
    if (durationIntervalRef.current) {
      return;
    }

    callStartTimeRef.current = Date.now();

    durationIntervalRef.current = setInterval(() => {
      if (!callStartTimeRef.current) {
        return;
      }

      const seconds = Math.floor(
        (Date.now() - callStartTimeRef.current) / 1000
      );

      setCallDuration(seconds);
    }, 1000);
  };

  // ----------------------------------------------------
  // STOP CALL TIMER
  // ----------------------------------------------------

  const stopCallTimer = () => {
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }

    callStartTimeRef.current = null;
    setCallDuration(0);
  };

  // ----------------------------------------------------
  // CREATE OFFER
  // ----------------------------------------------------

  const createOffer = async () => {
    try {
      console.log("Creating offer...");

      setCallStatus("Connecting...");

      const peerConnection =
        createPeerConnection();

      const offer =
        await peerConnection.createOffer();

      await peerConnection.setLocalDescription(
        offer
      );

      socketRef.current.emit(
        "offer",
        peerConnection.localDescription
      );

      console.log("Offer sent to agent");
    } catch (err) {
      console.error("Offer error:", err);

      setError("Unable to start voice call.");
    }
  };

  // ----------------------------------------------------
  // HANDLE OFFER
  // ----------------------------------------------------

  const handleOffer = async (offer) => {
    try {
      console.log("Offer received");

      setCallStatus("Connecting...");

      const peerConnection =
        createPeerConnection();

      await peerConnection.setRemoteDescription(
        new RTCSessionDescription(offer)
      );

      console.log("Remote description set");

      const answer =
        await peerConnection.createAnswer();

      await peerConnection.setLocalDescription(
        answer
      );

      socketRef.current.emit(
        "answer",
        peerConnection.localDescription
      );

      console.log("Answer sent to customer");

      // Add pending ICE candidates
      for (const candidate of pendingIceCandidatesRef.current) {
        try {
          await peerConnection.addIceCandidate(
            candidate
          );
        } catch (err) {
          console.error(
            "Pending ICE error:",
            err
          );
        }
      }

      pendingIceCandidatesRef.current = [];
    } catch (err) {
      console.error("Offer handling error:", err);

      setError("Failed to establish voice connection.");
    }
  };

  // ----------------------------------------------------
  // HANDLE ANSWER
  // ----------------------------------------------------

  const handleAnswer = async (answer) => {
    try {
      console.log("Answer received");

      if (!peerConnectionRef.current) {
        return;
      }

      await peerConnectionRef.current.setRemoteDescription(
        new RTCSessionDescription(answer)
      );

      console.log("Offer/Answer completed");

      // Add pending ICE candidates
      for (const candidate of pendingIceCandidatesRef.current) {
        try {
          await peerConnectionRef.current.addIceCandidate(
            candidate
          );
        } catch (err) {
          console.error(
            "Pending ICE error:",
            err
          );
        }
      }

      pendingIceCandidatesRef.current = [];
    } catch (err) {
      console.error("Answer error:", err);
    }
  };

  // ----------------------------------------------------
  // HANDLE ICE
  // ----------------------------------------------------

  const handleIceCandidate = async (candidate) => {
    try {
      if (!peerConnectionRef.current) {
        return;
      }

      if (
        peerConnectionRef.current.remoteDescription
      ) {
        await peerConnectionRef.current.addIceCandidate(
          new RTCIceCandidate(candidate)
        );
      } else {
        pendingIceCandidatesRef.current.push(
          new RTCIceCandidate(candidate)
        );
      }
    } catch (err) {
      console.error("ICE candidate error:", err);
    }
  };

  // ----------------------------------------------------
  // RESET WEBRTC
  // ----------------------------------------------------

  const resetPeerConnection = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    pendingIceCandidatesRef.current = [];
  };

  // ----------------------------------------------------
  // END CALL
  // ----------------------------------------------------

  const endCall = () => {
    console.log("Ending call");

    socketRef.current?.emit("end-call");

    cleanupCall();

    setCallStatus("Call ended");
  };

  // ----------------------------------------------------
  // CLEANUP CALL
  // ----------------------------------------------------

  const cleanupCall = () => {
    resetPeerConnection();

    stopCallTimer();

    setCallActive(false);
    setIsMuted(false);

    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
  };

  // ----------------------------------------------------
  // MUTE / UNMUTE
  // ----------------------------------------------------

  const toggleMute = () => {
    if (!localStreamRef.current) {
      return;
    }

    const audioTracks =
      localStreamRef.current.getAudioTracks();

    audioTracks.forEach((track) => {
      track.enabled = !track.enabled;
    });

    const muted = !audioTracks[0]?.enabled;

    setIsMuted(muted);

    console.log(
      muted ? "Microphone muted" : "Microphone unmuted"
    );
  };

  // ----------------------------------------------------
  // ENABLE REMOTE AUDIO
  // ----------------------------------------------------

  const enableAudio = async () => {
    if (!remoteAudioRef.current) {
      return;
    }

    try {
      await remoteAudioRef.current.play();

      console.log("Remote audio enabled");

      setCallStatus(
        callActive ? "Connected" : "Audio enabled"
      );
    } catch (err) {
      console.error(
        "Could not play remote audio:",
        err
      );

      setError(
        "Browser blocked audio playback. Click Enable Audio again."
      );
    }
  };

  // ----------------------------------------------------
  // SEND CHAT MESSAGE
  // ----------------------------------------------------

  const sendMessage = (e) => {
    e.preventDefault();

    const text = messageText.trim();

    if (!text) {
      return;
    }

    if (!socketRef.current?.connected) {
      setError("Not connected to server.");
      return;
    }

    socketRef.current.emit("chat-message", {
      text,
    });

    setMessageText("");
  };

  // ----------------------------------------------------
  // SOCKET SETUP
  // ----------------------------------------------------

  useEffect(() => {
    const socket = io(SOCKET_URL);

    socketRef.current = socket;

    // -------------------------
    // CONNECT
    // -------------------------

    socket.on("connect", () => {
      console.log("Connected to server");
      console.log("Socket ID:", socket.id);

      setSocketConnected(true);
      setError("");

      createPeerConnection();

      console.log(
        `Sending ${role} join event`
      );

      socket.emit("join", role);
    });

    // -------------------------
    // JOINED
    // -------------------------

    socket.on("joined", (data) => {
      console.log("Joined as:", data.role);

      setJoined(true);
    });

    // -------------------------
    // AGENT READY
    // -------------------------

    socket.on("agent-ready", async () => {
      console.log(
        "Agent ready. Creating offer..."
      );

      if (role !== "customer") {
        return;
      }

      setCallStatus("Agent connected");

      const stream = await getMicrophone();

      if (!stream) {
        return;
      }

      createPeerConnection();

      await createOffer();
    });

    // -------------------------
    // CUSTOMER READY
    // -------------------------

    socket.on("customer-ready", async () => {
      console.log("Customer ready");

      if (role !== "agent") {
        return;
      }

      setCallStatus("Customer connected");

      await getMicrophone();

      createPeerConnection();

      socket.emit("ready");

      console.log("Agent ready event sent");
    });

    // -------------------------
    // OFFER
    // -------------------------

    socket.on("offer", async (offer) => {
      await getMicrophone();
      await handleOffer(offer);
    });

    // -------------------------
    // ANSWER
    // -------------------------

    socket.on("answer", async (answer) => {
      await handleAnswer(answer);
    });

    // -------------------------
    // ICE
    // -------------------------

    socket.on(
      "ice-candidate",
      async (candidate) => {
        await handleIceCandidate(candidate);
      }
    );

    // -------------------------
    // CHAT
    // -------------------------

    socket.on("chat-message", (message) => {
      console.log("Chat message:", message);

      setMessages((previous) => {
        // Prevent duplicate messages
        if (
          previous.some(
            (item) => item.id === message.id
          )
        ) {
          return previous;
        }

        return [...previous, message];
      });
    });

    // -------------------------
    // CALL ENDED
    // -------------------------

    socket.on("call-ended", (data) => {
      console.log("Call ended:", data);

      cleanupCall();

      setCallStatus("Call Ended");
    });

    // -------------------------
    // PEER DISCONNECTED
    // -------------------------

    socket.on(
      "peer-disconnected",
      (data) => {
        console.log(
          "Peer disconnected:",
          data
        );

        cleanupCall();

        setCallStatus("Call Ended");
        setError(
          "The other user disconnected."
        );
      }
    );

    // -------------------------
    // CONNECTION ERROR
    // -------------------------

    socket.on(
      "connection-error",
      (data) => {
        console.error(
          "Connection error:",
          data
        );

        setError(
          data?.message ||
            "Connection error occurred."
        );
      }
    );

    // -------------------------
    // SESSION REPLACED
    // -------------------------

    socket.on(
      "session-replaced",
      () => {
        setError(
          "Another user joined using the same role."
        );

        cleanupCall();
      }
    );

    // -------------------------
    // DISCONNECT
    // -------------------------

    socket.on("disconnect", () => {
      console.log("Disconnected from server");

      setSocketConnected(false);
      setJoined(false);

      cleanupCall();

      setCallStatus("Server disconnected");
    });

    // -------------------------
    // CLEANUP
    // -------------------------

    return () => {
      socket.disconnect();

      if (localStreamRef.current) {
        localStreamRef.current
          .getTracks()
          .forEach((track) => track.stop());

        localStreamRef.current = null;
      }

      cleanupCall();
    };
  }, [role]);

  // ----------------------------------------------------
  // UI
  // ----------------------------------------------------

  return (
    <div className="app">
      <div className="card">

        <h1>Real-Time Voice Chat</h1>

        <h2>
          You are a {role}
        </h2>

        <div className="status">
          <span
            className={
              socketConnected
                ? "dot connected"
                : "dot disconnected"
            }
          />

          {socketConnected
            ? "Server Connected"
            : "Server Disconnected"}
        </div>

        <div className="role">
          Role: <strong>{role}</strong>
        </div>

        {/* CALL STATUS */}

        <div className="call-status">
          {callStatus}
        </div>

        {/* TIMER */}

        {callActive && (
          <div className="timer">
            {formatDuration(callDuration)}
          </div>
        )}

        {/* MICROPHONE */}

        <button
          className="mic-button"
          onClick={getMicrophone}
          disabled={!!localStreamRef.current}
        >
          🎤{" "}
          {localStreamRef.current
            ? "Microphone Ready"
            : "Enable Microphone"}
        </button>

        {/* AUDIO ELEMENT */}

        <audio
          ref={remoteAudioRef}
          autoPlay
          playsInline
          controls={false}
        />

        {/* ENABLE AUDIO */}

        <button
          className="audio-button"
          onClick={enableAudio}
        >
          🔊 Enable Audio
        </button>

        {/* CALL CONTROLS */}

        <div className="controls">

          <button
            onClick={toggleMute}
            disabled={!localStreamRef.current}
          >
            {isMuted
              ? "🔊 Unmute"
              : "🔇 Mute"}
          </button>

          <button
            className="end-button"
            onClick={endCall}
            disabled={!callActive}
          >
            📞 End Call
          </button>

        </div>

        {/* ERROR */}

        {error && (
          <div className="error">
            {error}
          </div>
        )}

        {/* CHAT */}

        <div className="chat-section">

          <h3>💬 Chat</h3>

          <div className="messages">

            {messages.length === 0 && (
              <p className="empty">
                No messages yet.
              </p>
            )}

            {messages.map((message) => (
              <div
                key={message.id}
                className={
                  message.sender === role
                    ? "message own"
                    : "message"
                }
              >

                <div className="message-header">
                  <strong>
                    {message.sender}
                  </strong>

                  <span>
                    {formatMessageTime(
                      message.timestamp
                    )}
                  </span>
                </div>

                <div className="message-text">
                  {message.text}
                </div>

              </div>
            ))}

          </div>

          <form
            className="chat-form"
            onSubmit={sendMessage}
          >

            <input
              type="text"
              placeholder="Type a message..."
              value={messageText}
              onChange={(e) =>
                setMessageText(e.target.value)
              }
            />

            <button type="submit">
              Send
            </button>

          </form>

        </div>

      </div>
    </div>
  );
}

export default App;