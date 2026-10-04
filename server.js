const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const users = {
  customer: null,
  agent: null,
};

app.get("/", (req, res) => {
  res.send("Real-Time Voice Chat Server is running");
});

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // -----------------------------
  // JOIN
  // -----------------------------
  socket.on("join", (role) => {
    if (role !== "customer" && role !== "agent") {
      socket.emit("connection-error", {
        message: "Invalid role.",
      });
      return;
    }

    // Remove old socket for same role
    if (users[role] && users[role] !== socket.id) {
      const oldSocket = io.sockets.sockets.get(users[role]);

      if (oldSocket) {
        oldSocket.emit("session-replaced");
        oldSocket.disconnect(true);
      }
    }

    users[role] = socket.id;
    socket.data.role = role;

    console.log(`${socket.id} joined as ${role}`);
    console.log("Current users:", users);

    socket.emit("joined", {
      role,
    });

    // Tell customer when agent is available
    if (role === "agent" && users.customer) {
      console.log("Agent ready. Notifying customer.");

      io.to(users.customer).emit("agent-ready");
    }

    // Tell agent when customer is already available
    if (role === "customer" && users.agent) {
      console.log("Customer already available. Notifying agent.");

      io.to(users.agent).emit("customer-ready");
    }
  });

  // -----------------------------
  // AGENT READY
  // -----------------------------
  socket.on("ready", () => {
    if (socket.data.role !== "agent") {
      return;
    }

    const customerId = users.customer;

    console.log("READY received from:", socket.id);
    console.log("Customer ID:", customerId);

    if (customerId) {
      io.to(customerId).emit("agent-ready");
      console.log("Sending agent-ready to customer:", customerId);
    }
  });

  // -----------------------------
  // WEBRTC OFFER
  // -----------------------------
  socket.on("offer", (offer) => {
    const target =
      socket.data.role === "customer"
        ? users.agent
        : users.customer;

    if (!target) {
      socket.emit("connection-error", {
        message: "Other user is not connected.",
      });
      return;
    }

    console.log("Forwarding offer from", socket.id, "to", target);

    io.to(target).emit("offer", offer);
  });

  // -----------------------------
  // WEBRTC ANSWER
  // -----------------------------
  socket.on("answer", (answer) => {
    const target =
      socket.data.role === "agent"
        ? users.customer
        : users.agent;

    if (!target) {
      return;
    }

    console.log("Forwarding answer from", socket.id, "to", target);

    io.to(target).emit("answer", answer);
  });

  // -----------------------------
  // ICE CANDIDATE
  // -----------------------------
  socket.on("ice-candidate", (candidate) => {
    const target =
      socket.data.role === "customer"
        ? users.agent
        : users.customer;

    if (!target) {
      return;
    }

    io.to(target).emit("ice-candidate", candidate);
  });

  // -----------------------------
  // CHAT MESSAGE
  // -----------------------------
  socket.on("chat-message", (message) => {
    const target =
      socket.data.role === "customer"
        ? users.agent
        : users.customer;

    if (!target) {
      socket.emit("connection-error", {
        message: "Other user is not connected.",
      });
      return;
    }

    const chatMessage = {
      id: Date.now() + "-" + Math.random(),
      sender: socket.data.role,
      text: message.text,
      timestamp: new Date().toISOString(),
    };

    // Send to both users
    socket.emit("chat-message", chatMessage);
    io.to(target).emit("chat-message", chatMessage);
  });

  // -----------------------------
  // END CALL
  // -----------------------------
  socket.on("end-call", () => {
    const target =
      socket.data.role === "customer"
        ? users.agent
        : users.customer;

    console.log("Call ended by:", socket.id);

    if (target) {
      io.to(target).emit("call-ended", {
        reason: "The other user ended the call.",
      });
    }

    socket.emit("call-ended", {
      reason: "You ended the call.",
    });
  });

  // -----------------------------
  // DISCONNECT
  // -----------------------------
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    const role = socket.data.role;

    if (role && users[role] === socket.id) {
      users[role] = null;
    }

    const otherRole = role === "customer"
      ? "agent"
      : "customer";

    const otherUser = users[otherRole];

    if (otherUser) {
      io.to(otherUser).emit("peer-disconnected", {
        message: "The other user has disconnected. Call ended.",
      });
    }

    console.log("Users after disconnect:", users);
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});