require("dotenv").config();

const express = require("express");
const bcrypt = require("bcryptjs");
const { MongoClient, ObjectId } = require("mongodb");
const WebSocket = require("ws");

(async () => {
  try {
    console.log("Подключаемся к MongoDB...");
    const client = await MongoClient.connect(process.env.DB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("Подключение к MongoDB успешно");

    const app = express();

    app.use((req, res, next) => {
      req.db = client.db("users");
      next();
    });

    app.use(express.json());

    // --- Функции для работы с пользователями, сессиями и таймерами ---

    const hash = async (password) => {
      if (!password) {
        throw new Error("Пароль не может быть пустым");
      }
      const saltRounds = 10;
      return await bcrypt.hash(password, saltRounds);
    };

    const findUserByUsername = async (db, username) => db.collection("users").findOne({ username });

    const findUserBySessionId = async (db, sessionId) => {
      const session = await db
        .collection("sessions")
        .findOne({ _id: new ObjectId(sessionId) }, { projection: { userId: 1 } });
      if (!session) return null;
      return db.collection("users").findOne({ _id: new ObjectId(session.userId) });
    };

    const createUser = async (db, username, password) => {
      const existingUser = await findUserByUsername(db, username);
      if (existingUser) {
        throw new Error("Пользователь с таким именем уже существует");
      }
      const hashedPassword = await hash(password);
      const result = await db.collection("users").insertOne({ username, password: hashedPassword });
      return result.insertedId;
    };

    const createSession = async (db, userId) => {
      const result = await db.collection("sessions").insertOne({
        userId: new ObjectId(userId),
      });
      return result.insertedId.toHexString();
    };

    const deleteSession = async (db, sessionId) => {
      await db.collection("sessions").deleteOne({ _id: new ObjectId(sessionId) });
    };

    const getTimersForUser = async (db, userId) => {
      return db
        .collection("timers")
        .find({ user_id: new ObjectId(userId) })
        .toArray();
    };

    const createTimer = async (db, userId, description) => {
      const newTimer = {
        user_id: new ObjectId(userId),
        start: new Date(),
        description,
        is_active: true,
      };
      const result = await db.collection("timers").insertOne(newTimer);
      console.log("Создан новый таймер:", newTimer);
      return { ...newTimer, _id: result.insertedId };
    };

    const stopTimer = async (db, timerId, userId) => {
      try {
            console.log("Пытаемся остановить таймер с ID:", timerId, "и userId:", userId);
            const result = await db.collection("timers").findOneAndUpdate(
              { _id: new ObjectId(timerId), user_id: new ObjectId(userId) },
              {
                $set: {
                  end: new Date(),
                  is_active: false,
                },
              },
              {
                returnDocument: "after",
              }
            );
            console.log("Результат findOneAndUpdate:", result);
           // Проверяем, где находится обновленный таймер
            const updatedTimer = result.value || result;
            if (!updatedTimer) {
              console.error("Таймер не найден для обновления");
              return null;
            }
            console.log("Таймер успешно остановлен:", updatedTimer);
            return updatedTimer;
          } catch (error) {
        console.error("Ошибка при остановке таймера:", error);
        throw new Error("Ошибка при остановке таймера");
      }
    };

    // Авторизация
    const auth = () => async (req, res, next) => {
      let sessionId = req.headers["authorization"];
      if (sessionId && sessionId.startsWith("Bearer ")) {
        sessionId = sessionId.slice(7);
      }
      if (!sessionId) {
        sessionId = req.query.sessionId;
      }
      if (!sessionId) {
        return next();
      }
      try {
        const user = await findUserBySessionId(req.db, sessionId);
        if (!user) {
          return res.status(401).json({ error: "Вы не авторизованы" });
        }
        req.user = user;
        req.sessionId = sessionId;
        next();
      } catch (error) {
        console.error("Ошибка при авторизации:", error);
        return res.status(401).json({ error: "Вы не авторизованы" });
      }
    };

    // --- Маршруты ---
    app.post("/signup", async (req, res) => {
      const { username, password } = req.body;
      if (!username || !password) {
        return res.status(400).json({ error: "Имя пользователя и пароль обязательны!" });
      }
      try {
        const userId = await createUser(req.db, username, password);
        const sessionId = await createSession(req.db, userId);
        res.json({ sessionId });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    app.post("/login", async (req, res) => {
      const { username, password } = req.body;
      if (!username || !password) {
        return res.status(400).json({ error: "Имя пользователя и пароль обязательны!" });
      }
      const user = await findUserByUsername(req.db, username);
      if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(400).json({ error: "Неверное имя пользователя или пароль!" });
      }
      const sessionId = await createSession(req.db, user._id);
      res.json({ sessionId });
    });

    app.get("/logout", auth(), async (req, res) => {
      if (!req.user) {
        return res.json({});
      }
      await deleteSession(req.db, req.sessionId);
      res.json({});
    });

    app.get("/api/timers", auth(), async (req, res) => {
      if (!req.user) {
        return res.status(401).json({ error: "Вы не авторизованы" });
      }
      try {
        const timers = await getTimersForUser(req.db, req.user._id);
        const currentTime = Date.now();
        const updatedTimers = timers.map((timer) => {
          timer.start = new Date(timer.start);
          if (timer.is_active) {
            timer.progress = currentTime - timer.start.getTime();
          } else if (timer.end) {
            timer.end = new Date(timer.end);
            timer.duration = timer.end.getTime() - timer.start.getTime();
          } else {
            timer.duration = 0;
          }
          return timer;
        });
        res.json(updatedTimers);
      } catch (error) {
        res.status(500).json({ error: "Ошибка сервера" });
      }
    });

    app.post("/api/timers", auth(), async (req, res) => {
      if (!req.user) {
        return res.status(401).json({ error: "Вы не авторизованы" });
      }
      const { description } = req.body;
      try {
        const newTimer = await createTimer(req.db, req.user._id, description);
        res.json(newTimer);
      } catch (error) {
        res.status(500).json({ error: "Ошибка сервера" });
      }
    });

    app.post("/api/timers/:id/stop", auth(), async (req, res) => {
      if (!req.user) {
        return res.status(401).json({ error: "Вы не авторизованы" });
      }
      const timerId = req.params.id;
      try {
        const updatedTimer = await stopTimer(req.db, timerId, req.user._id);
        if (!updatedTimer) {
          return res.status(404).json({ error: "Таймер не найден" });
        }
        res.json(updatedTimer);
      } catch (error) {
        console.error("Ошибка при остановке таймера:", error);
        res.status(500).json({ error: "Ошибка сервера" });
      }
    });

    // --- WebSocket ---
    const wss = new WebSocket.Server({ noServer: true });

    //  Функция для отправки актуального списка таймеров клиенту
    const sendTimersToClient = async (ws, db, userId) => {
      const allTimers = await getTimersForUser(db, userId);
      ws.send(JSON.stringify({ type: "all_timers", data: allTimers }));
    };

    wss.on("connection", async (ws, req) => {
      const sessionId = req.sessionId;
      const db = client.db("users");

      const user = await findUserBySessionId(db, sessionId);
      if (!user) {
        ws.close();
        return;
      }

      await sendTimersToClient(ws, db, user._id);

      ws.on("message", async (message) => {
        try {
          const { action, description, timerId } = JSON.parse(message);
          if (action === "create_timer") {
            await createTimer(db, user._id, description);
            await sendTimersToClient(ws, db, user._id);
          } else if (action === "stop_timer") {
            await stopTimer(db, timerId, user._id);
            await sendTimersToClient(ws, db, user._id);
          }
        } catch (err) {
          console.error("Ошибка обработки сообщения WS:", err);
        }
      });

      const intervalId = setInterval(async () => {
        try {
          const activeTimers = await getTimersForUser(db, user._id);
          const activeTimersWithProgress = activeTimers.map((timer) => {
            if (timer.is_active) {
              timer.progress = Date.now() - new Date(timer.start).getTime();
            }
            return timer;
          });
          ws.send(JSON.stringify({ type: "active_timers", data: activeTimersWithProgress }));
        } catch (err) {
          console.error("Ошибка отправки активных таймеров:", err);
        }
      }, 1000);

      ws.on("close", () => {
        clearInterval(intervalId);
      });
    });

    const server = app.listen(process.env.PORT || 3000, () => {
      console.log(`Listening on http://localhost:${process.env.PORT || 3000}`);
    });

    server.on("upgrade", (request, socket, head) => {
      const sessionId = request.headers["sec-websocket-protocol"];
      if (sessionId) {
        request.sessionId = sessionId;
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, request);
        });
      } else {
        socket.destroy();
      }
    });
  } catch (err) {
    console.error("Ошибка подключения к MongoDB:", err);
    process.exit(1);
  }
})();
