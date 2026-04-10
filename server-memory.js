const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

// Secret keys for signing JWTs
const JWT_SECRET = 'kjdkfjasldkjfkjd';
const REFRESH_SECRET = 'dkjakdjfkdjkjfd';

// In-memory storage (resets when server restarts)
const users = [];
const refreshTokens = [];

// Parse JSON request bodies
app.use(express.json());

// Serve static files from public/
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

// Middleware to verify JWT
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

// ============================================================
// Public Routes
// ============================================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', storage: 'in-memory' });
});

app.get('/api/redis-info', (req, res) => {
  res.json({
    storage: 'in-memory',
    users: users.length,
    refreshTokens: refreshTokens.length,
    cacheEntries: [],
    note: 'No Redis — all data lives in process memory and is lost on restart',
  });
});

// ============================================================
// Auth Routes (in-memory storage)
// ============================================================

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  if (users.find(u => u.username === username)) {
    return res.status(409).json({ error: 'Username already exists' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  users.push({ username, password: hashedPassword });

  res.status(201).json({ message: `User '${username}' registered successfully` });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  const user = users.find(u => u.username === username);
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const validPassword = await bcrypt.compare(password, user.password);
  if (!validPassword) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '15m' });
  const refreshToken = jwt.sign({ username: user.username }, REFRESH_SECRET, { expiresIn: '7d' });
  refreshTokens.push(refreshToken);

  res.json({ token, refreshToken });
});

app.post('/api/refresh', (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(401).json({ error: 'Refresh token required' });
  }

  if (!refreshTokens.includes(refreshToken)) {
    return res.status(403).json({ error: 'Refresh token revoked or invalid' });
  }

  jwt.verify(refreshToken, REFRESH_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired refresh token' });
    }

    const newToken = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '15m' });
    res.json({ token: newToken });
  });
});

app.post('/api/logout', (req, res) => {
  const { refreshToken } = req.body;
  const index = refreshTokens.indexOf(refreshToken);
  if (index > -1) {
    refreshTokens.splice(index, 1);
  }
  res.json({ message: 'Logged out successfully' });
});

// ============================================================
// Data Routes (NO caching — always slow)
// ============================================================

async function slowDataFetch(query) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return {
    query,
    results: [
      { id: 1, name: 'Widget A', price: 9.99 },
      { id: 2, name: 'Widget B', price: 19.99 },
      { id: 3, name: 'Widget C', price: 29.99 },
    ],
    generatedAt: new Date().toISOString(),
  };
}

app.get('/api/data/no-cache', authenticateToken, async (req, res) => {
  const query = req.query.q || 'default';
  const start = Date.now();
  const data = await slowDataFetch(query);
  const elapsed = Date.now() - start;

  res.json({
    ...data,
    responseTime: `${elapsed}ms`,
    source: 'direct (no cache)',
  });
});

// Same endpoint exists but has no cache — always slow
app.get('/api/data/cached', authenticateToken, async (req, res) => {
  const query = req.query.q || 'default';
  const start = Date.now();
  const data = await slowDataFetch(query);
  const elapsed = Date.now() - start;

  res.json({
    ...data,
    responseTime: `${elapsed}ms`,
    source: 'direct (no cache available — in-memory server)',
  });
});

app.post('/api/cache/clear', authenticateToken, (req, res) => {
  res.json({ message: 'No cache to clear (in-memory server)' });
});

// Protected route
app.get('/api/secret', authenticateToken, (req, res) => {
  res.json({
    message: 'This is a secret message!',
    user: req.user.username,
  });
});

// ============================================================
// Start Server
// ============================================================

app.listen(PORT, () => {
  console.log(`[IN-MEMORY] Server running on http://localhost:${PORT}`);
  console.log('Warning: All data is stored in process memory and will be lost on restart.');
});
