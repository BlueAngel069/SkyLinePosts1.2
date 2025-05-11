const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// In-memory user activity tracking
const userActivity = {};

// Ensure upload directory exists
const uploadDir = path.join(__dirname, '../public/uploads/messages');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// Middleware to require login and track activity
function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  userActivity[req.session.user.username] = Date.now();
  next();
}

// Utility to get online status
function getOnlineStatus(username) {
  const lastActivity = userActivity[username];
  if (!lastActivity) return 'Offline';
  const secondsAgo = Math.floor((Date.now() - lastActivity) / 1000);
  return secondsAgo <= 30 ? 'Online' : `Last seen ${secondsAgo} seconds ago`;
}

// View chat with a friend
router.get('/chat/:recipient', requireLogin, (req, res) => {
  const currentUser = req.session.user.username;
  const recipient = req.params.recipient;

  db.all(`
    SELECT rowid AS id, sender, content, timestamp FROM messages
    WHERE (sender = ? AND recipient = ?)
       OR (sender = ? AND recipient = ?)
    ORDER BY timestamp ASC
  `, [currentUser, recipient, recipient, currentUser], (err, rows) => {
    if (err) {
      console.error('DB Error:', err.message);
      return res.send('Error loading messages.');
    }

    const lastMessageId = rows.length > 0 ? rows[rows.length - 1].id : null;

    if (lastMessageId !== null) {
      db.run(`
        INSERT INTO read_receipts (username, chat_with, last_read_message_id)
        VALUES (?, ?, ?)
        ON CONFLICT(username, chat_with) DO UPDATE SET last_read_message_id = excluded.last_read_message_id
      `, [currentUser, recipient, lastMessageId], (err) => {
        if (err) console.error('Failed to update read receipt:', err.message);

        db.get(`
          SELECT last_read_message_id FROM read_receipts
          WHERE username = ? AND chat_with = ?
        `, [recipient, currentUser], (err, readRow) => {
          const recipientLastReadId = readRow ? readRow.last_read_message_id : null;
          res.render('chat', {
            recipient,
            messages: rows,
            recipientLastReadId,
            user: req.session.user,
            onlineStatus: getOnlineStatus(recipient)
          });
        });
      });
    } else {
      res.render('chat', {
        recipient,
        messages: rows,
        recipientLastReadId: null,
        user: req.session.user,
        onlineStatus: getOnlineStatus(recipient)
      });
    }
  });
});

// Send a message with optional image
router.post('/chat/:recipient', requireLogin, upload.single('image'), (req, res) => {
  const currentUser = req.session.user.username;
  const recipient = req.params.recipient;
  const messageContent = req.body.message;
  const imagePath = req.file ? `/uploads/messages/${req.file.filename}` : null;
  const timestamp = new Date().toLocaleString();

  // Store message as JSON with text and optional image
  const contentObject = {
    text: messageContent,
    image: imagePath
  };
  const content = JSON.stringify(contentObject);

  db.run(`
    INSERT INTO messages (sender, recipient, content, timestamp)
    VALUES (?, ?, ?, ?)
  `, [currentUser, recipient, content, timestamp], (err) => {
    if (err) {
      console.error("Insert failed:", err.message);
      return res.send('Error sending message.');
    }

    res.redirect(`/messages/chat/${recipient}`);
  });
});

// Start chat from button
router.post('/start', requireLogin, (req, res) => {
  const recipient = req.body.recipient;
  res.redirect(`/messages/chat/${recipient}`);
});

// View all conversation partners
router.get('/conversations', requireLogin, (req, res) => {
  const currentUser = req.session.user.username;

  db.all(`
    SELECT DISTINCT 
      CASE 
        WHEN sender = ? THEN recipient 
        ELSE sender 
      END AS conversation_partner
    FROM messages
    WHERE sender = ? OR recipient = ?
  `, [currentUser, currentUser, currentUser], (err, rows) => {
    if (err) {
      console.error('DB Error:', err.message);
      return res.send('Error loading conversations.');
    }

    const conversations = rows.map(row => row.conversation_partner);
    res.render('conversations', { conversations });
  });
});

// Typing status routes (unchanged)
router.post('/typing/:recipient', requireLogin, (req, res) => {
  const currentUser = req.session.user.username;
  db.run(`
    INSERT INTO typing_status (username, is_typing) 
    VALUES (?, 1)
    ON CONFLICT(username) DO UPDATE SET is_typing = 1
  `, [currentUser], () => {
    res.sendStatus(200);
  });
});

router.post('/stop-typing/:recipient', requireLogin, (req, res) => {
  const currentUser = req.session.user.username;
  db.run(`UPDATE typing_status SET is_typing = 0 WHERE username = ?`, [currentUser], () => {
    res.sendStatus(200);
  });
});

router.get('/typing-status/:recipient', requireLogin, (req, res) => {
  const recipient = req.params.recipient;
  db.get(`SELECT is_typing FROM typing_status WHERE username = ?`, [recipient], (err, row) => {
    res.json({ isTyping: row && row.is_typing === 1 });
  });
});

module.exports = router;
