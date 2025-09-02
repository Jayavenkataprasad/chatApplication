const express = require("express");
const path = require("path");
const app = express();
app.use(express.json());
const { open } = require("sqlite");
const sqlite3 = require("sqlite3");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const http = require("http");
const { Server } = require("socket.io");
app.use(cors());

const server = http.createServer(app); 
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const usersSocketMap = {};

const dbPath = path.join(__dirname, "usersData.db");

const initializeDBAndServer = async () => {
  try {
    db = await open({
      filename: dbPath,
      driver: sqlite3.Database,
    });
    await db.run(`
      CREATE TABLE IF NOT EXISTS messagesTable (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        receiver TEXT NOT NULL,
        message TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        type TEXT DEFAULT 'public'
      )
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS usersData (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT
      )
    `);

    server.listen(3000, () => {
      console.log("Server Running at http://localhost:3000");
    });
  } catch (e) {
    console.log(`DB Error: ${e.message}`);
    process.exit(1);
  }
};
initializeDBAndServer();

app.use(express.json());

//post
app.post("/register", async (request, response) => {
  const { username, password } = request.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  const checkUserQuery = `SELECT * FROM usersData WHERE username = '${username}'`;
  const userExists = await db.get(checkUserQuery);

  if (userExists) {
    response.status(400).json({ error: "User already exists" });
  } else {
    const createUserQuery = `INSERT INTO usersData (username, password) VALUES (?, ?)`;
    await db.run(createUserQuery, [username, hashedPassword]);
    response.status(201).json({ message: "User created successfully" });
  }
});

app.post("/login", async (request, response) => {
  const { username, password } = request.body;
  const checkUserQuery = `SELECT * FROM usersData WHERE username = ?`;
  const user = await db.get(checkUserQuery, [username]);

  if (user === undefined) {
    response.status(400).json({ error: "No user exists" });
  } else {
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (isPasswordValid) {
      const payload = { username: user.username };
      const token = jwt.sign(payload, "SECRET_KEY");
      response.status(200).json({
        message: "Login successful",
        token: token,
        username: user.username,
      });
    } else {
      response.status(400).json({ error: "Invalid username or password" });
    }
  }
});

app.get("/users", async (request, response) => {
  const getUsersQuery = `SELECT username FROM usersData`;
  const users = await db.all(getUsersQuery);
  response.status(200).json(users);
});

app.post("/messages", async (req, res) => {
  const { sender, message } = req.body;

  if (!sender || !message) {
    return res.status(400).json({ error: "All fields are required" });
  }

  const query = `INSERT INTO messagesTable (sender, receiver, message) VALUES (?, 'all', ?)`;

  try {
    await db.run(query, [sender, message]);
    res.status(201).json({ message: "Message stored successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to store message" });
  }
});

app.get("/messages", async (req, res) => {
  try {
    const messages = await db.all(
      `SELECT * FROM messagesTable WHERE receiver = 'all' ORDER BY timestamp ASC`
    );
    res.status(200).json(messages);
  } catch (error) {
    res.status(500).json({ error: "Failed to retrieve messages" });
  }
});

app.get("/messages/private", async (req, res) => {
  const { user1, user2 } = req.query;
  if (!user1 || !user2) {
    return res.status(400).json({ error: "Two usernames required" });
  }

  try {
    const messages = await db.all(
      `SELECT * FROM messagesTable
       WHERE type = 'private' AND (
         (sender = ? AND receiver = ?)
         OR
         (sender = ? AND receiver = ?)
       )
       ORDER BY timestamp ASC`,
      [user1, user2, user2, user1]
    );
    res.status(200).json(messages);
  } catch (err) {
    res.status(500).json({ error: "Could not fetch private messages" });
  }
});

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);
  // Step 1: Register user with their socket ID
  socket.on("register_user", (username) => {
    usersSocketMap[username] = socket.id;
    console.log(`Registered user ${username} with socket ${socket.id}`);
  });

  // Step 2: Handle sending messages (public or private)
  socket.on("send_message", async ({ sender, receiver, message, type }) => {
    if (!sender || !message || !type) return;

    const timestamp = new Date().toISOString();

    try {
      await db.run(
        `INSERT INTO messagesTable (sender, receiver, message, timestamp, type) VALUES (?, ?, ?, ?, ?)`,
        [sender, receiver, message, timestamp, type]
      );

      const messagePayload = {
        sender,
        receiver,
        message,
        timestamp,
        type,
      };

      if (type === "public") {
        io.emit("receive_message", messagePayload);
      } else if (type === "private") {
        const receiverSocketId = usersSocketMap[receiver];
        if (receiverSocketId) {
          io.to(receiverSocketId).emit("receive_message", messagePayload);
        }
        // Optionally, send message back to sender for confirmation/display
        socket.emit("receive_message", messagePayload);
      }
    } catch (error) {
      console.error("Message sending error:", error);
    }
  });

  // Step 3: Handle disconnection
  socket.on("disconnect", () => {
    for (const [username, id] of Object.entries(usersSocketMap)) {
      if (id === socket.id) {
        delete usersSocketMap[username];
        console.log(`User ${username} disconnected.`);
        break;
      }
    }
    console.log("Client disconnected:", socket.id);
  });
});
