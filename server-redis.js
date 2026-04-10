require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('redis');

const app = express();
const PORT = process.env.PORT || 3000;

// Secret keys for signing JWTs (in production, use environment variables!)
const JWT_SECRET = process.env.JWT_SECRET || 'kjdkfjasldkjfkjd';
const REFRESH_SECRET = process.env.REFRESH_SECRET || 'dkjakdjfkdjkjfd';

// Redis client setup
// Build connection URL from REDIS_URL (host:port), REDIS_USER, and REDIS_PASSWORD
const redisHost = process.env.REDIS_URL || 'localhost:6379';
const redisUser = process.env.REDIS_USER || 'default';
const redisPassword = process.env.REDIS_PASSWORD || '';
const redisConnectionUrl = redisPassword
  ? `redis://${redisUser}:${redisPassword}@${redisHost}`
  : `redis://${redisHost}`;
const redis = createClient({ url: redisConnectionUrl });

redis.on('error', (err) => console.error('Redis Client Error:', err));
redis.on('connect', () => console.log('Connected to Redis'));

// Parse JSON request bodies
app.use(express.json());

// Serve static files from public/
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

// Middleware to verify JWT
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // "Bearer TOKEN"

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

// Health check - also shows Redis connection status
app.get('/api/health', async (req, res) => {
  try {
    await redis.ping();
    res.json({ status: 'ok', redis: 'connected' });
  } catch {
    res.json({ status: 'ok', redis: 'disconnected' });
  }
});

// Redis info - shows what's stored in Redis
app.get('/api/redis-info', async (req, res) => {
  try {
    const userKeys = await redis.keys('user:*');
    const refreshCount = await redis.sCard('refresh_tokens');
    const cacheKeys = await redis.keys('cache:*');

    // Get TTL for each cache key
    const cacheInfo = [];
    for (const key of cacheKeys) {
      const ttl = await redis.ttl(key);
      cacheInfo.push({ key, ttl });
    }

    res.json({
      users: userKeys.length,
      refreshTokens: refreshCount,
      cacheEntries: cacheInfo,
    });
  } catch (err) {
    res.status(500).json({ error: 'Redis error', details: err.message });
  }
});

// ============================================================
// Auth Routes (using Redis for storage)
// ============================================================

// Register a new user - stores in Redis Hash
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  // Check if user already exists (Redis Hash)
  const existingUser = await redis.hGet(`user:${username}`, 'username');
  if (existingUser) {
    return res.status(409).json({ error: 'Username already exists' });
  }

  // Hash the password
  const hashedPassword = await bcrypt.hash(password, 10);

  // Store user as a Redis Hash: user:{username} -> { username, password }
  await redis.hSet(`user:${username}`, {
    username,
    password: hashedPassword,
  });

  res.status(201).json({ message: `User '${username}' registered successfully` });
});

// Login and receive access + refresh tokens
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  // Look up user from Redis Hash
  const storedPassword = await redis.hGet(`user:${username}`, 'password');
  if (!storedPassword) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // Compare passwords
  const validPassword = await bcrypt.compare(password, storedPassword);
  if (!validPassword) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // Create an access token (short-lived)
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '15m' });

  // Create a refresh token (long-lived)
  const refreshToken = jwt.sign({ username }, REFRESH_SECRET, { expiresIn: '7d' });

  // Store refresh token in a Redis Set
  await redis.sAdd('refresh_tokens', refreshToken);

  res.json({ token, refreshToken });
});

// Get a new access token using a refresh token
app.post('/api/refresh', async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(401).json({ error: 'Refresh token required' });
  }

  // Check if the refresh token is in our Redis Set (not revoked)
  const exists = await redis.sIsMember('refresh_tokens', refreshToken);
  if (!exists) {
    return res.status(403).json({ error: 'Refresh token revoked or invalid' });
  }

  // Verify the refresh token
  jwt.verify(refreshToken, REFRESH_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired refresh token' });
    }

    // Issue a new access token
    const newToken = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '15m' });
    res.json({ token: newToken });
  });
});

// Logout - revoke the refresh token
app.post('/api/logout', async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    await redis.sRem('refresh_tokens', refreshToken);
  }
  res.json({ message: 'Logged out successfully' });
});

// ============================================================
// Caching Demo Routes
// ============================================================

// Simulates a slow API call (e.g., a complex database query or external API)
async function slowDataFetch(query) {
  // Simulate 2-second delay
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

// Slow endpoint - always fetches fresh data (no cache)
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

// Cached endpoint - checks Redis first, falls back to slow fetch
app.get('/api/data/cached', authenticateToken, async (req, res) => {
  const query = req.query.q || 'default';
  const cacheKey = `cache:data:${query}`;
  const start = Date.now();

  // Try to get from Redis cache
  const cached = await redis.get(cacheKey);
  if (cached) {
    const elapsed = Date.now() - start;
    const data = JSON.parse(cached);
    return res.json({
      ...data,
      responseTime: `${elapsed}ms`,
      source: 'redis cache (HIT)',
    });
  }

  // Cache miss - fetch the slow way
  const data = await slowDataFetch(query);

  // Store in Redis with a 30-second TTL
  await redis.set(cacheKey, JSON.stringify(data), { EX: 30 });

  const elapsed = Date.now() - start;
  res.json({
    ...data,
    responseTime: `${elapsed}ms`,
    source: 'direct (cache MISS - now cached for 30s)',
  });
});

// Clear cache manually
app.post('/api/cache/clear', authenticateToken, async (req, res) => {
  const keys = await redis.keys('cache:*');
  if (keys.length > 0) {
    await redis.del(keys);
  }
  res.json({ message: `Cleared ${keys.length} cache entries` });
});

// Protected route - requires valid JWT
app.get('/api/secret', authenticateToken, (req, res) => {
  res.json({
    message: 'This is a secret message!',
    user: req.user.username,
  });
});

// ============================================================
// Start Server
// ============================================================

async function start() {
  await redis.connect();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
