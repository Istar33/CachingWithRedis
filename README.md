# Lab: Caching with Redis

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/RPI-WS-spring-2026/CachingWithRedis)

Build on the JWT authentication API from the previous lab by replacing in-memory storage with **Redis** and adding a **caching layer** that dramatically speeds up slow API calls.

**Time:** ~1 hour
**Environment:** GitHub Codespaces + Redis Cloud (free tier)
**Prerequisites:** Completed the JWT Authentication lab

---

## What You'll Learn

- How to connect a Node.js app to a Redis Cloud database
- Redis data types in practice: **Hashes** (user storage), **Sets** (token management), **Strings** (caching)
- The cache-aside pattern: check cache first, fall back to the source, store the result
- TTL (Time-To-Live): automatic cache expiration
- Why caching matters: see the speed difference with your own eyes

---

## Part 0: Set Up Redis Cloud (~10 min)

You'll use a **free** Redis Cloud database. No credit card required.

**1. Create a Redis Cloud account:**

Go to [redis.io/try-free](https://redis.io/try-free/) and sign up (you can use your GitHub account).

**2. Create a free database:**

- After signing in, you'll land on the dashboard
- A free 30MB database is created automatically (or click **New Database**)
- Choose the **Free** tier and pick any cloud region

**3. Get your connection URL:**

- Click on your database in the dashboard
- Find the **Public endpoint** (looks like `redis-12345.c1.us-east-1-2.ec2.redns.redis-cloud.com:12345`)
- Find or set the **Default user password**
- Your connection URL is: `redis://default:<password>@<endpoint>`

**4. Save it somewhere** - you'll need this URL in the next step.

> **Example:** `redis://default:abc123xyz@redis-12345.c1.us-east-1-2.ec2.redns.redis-cloud.com:16379`

---

## Part 1: Open Your Codespace (~5 min)

1. Accept the GitHub Classroom assignment using the link provided by your instructor
2. Go to **your** assignment repository
3. Click the green **Code** button, then the **Codespaces** tab
4. Click **Create codespace on main**

**5. Configure your Redis connection:**

Copy the example environment file and fill in your Redis Cloud URL:

```bash
cp .env.example .env
```

Edit `.env` and fill in your Redis Cloud connection details from Part 0:

```
REDIS_URL=redis-12345.c232.us-east-1-2.ec2.cloud.redislabs.com:12345
REDIS_USER=default
REDIS_PASSWORD=your-password-here
```

- `REDIS_URL` is the **Public endpoint** (host:port) from your Redis Cloud dashboard
- `REDIS_USER` is the **username** (usually `default`)
- `REDIS_PASSWORD` is the **Default user password**

The server uses the `dotenv` package to automatically load these from `.env`. The `.env` file is in `.gitignore` so your credentials won't be committed.

> **Codespace secrets (alternative):** You can also set `REDIS_URL`, `REDIS_USER`, and `REDIS_PASSWORD` as Codespace secrets at **Settings > Secrets and variables > Codespaces**. This is useful if you don't want to create a `.env` file each time.

---

## Part 2: Explore the Starter Code (~5 min)

The project already has a working JWT authentication server from the previous lab. Look at `server.js`:

```bash
cat server.js
```

Notice it currently uses **in-memory arrays** for storage:

```js
const users = [];          // Resets when server restarts!
const refreshTokens = [];  // Gone forever on restart!
```

**The problem:** Every time the server restarts (which happens on every code change with `--watch`), all registered users and tokens are lost.

**The solution:** Store data in Redis, which persists independently of the server.

---

## Part 3: Install Redis and Connect (~10 min)

**1. Install dependencies:**

```bash
npm install
```

This installs `redis` and `dotenv` (along with express, bcryptjs, and jsonwebtoken from the previous lab).

**2. Add Redis to `server.js`:**

At the very top of your file, add `dotenv` so `.env` variables are loaded automatically:

```js
require('dotenv').config();
```

Then, after the other `require` statements, add:

```js
const { createClient } = require('redis');

// Redis client setup - reads REDIS_URL, REDIS_USER, and REDIS_PASSWORD from .env
const redisHost = process.env.REDIS_URL || 'localhost:6379';
const redisUser = process.env.REDIS_USER || 'default';
const redisPassword = process.env.REDIS_PASSWORD || '';
const redisConnectionUrl = redisPassword
  ? `redis://${redisUser}:${redisPassword}@${redisHost}`
  : `redis://${redisHost}`;
const redis = createClient({ url: redisConnectionUrl });

redis.on('error', (err) => console.error('Redis Client Error:', err));
redis.on('connect', () => console.log('Connected to Redis'));
```

**3. Connect before starting the server:**

Replace your `app.listen(...)` call with:

```js
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
```

**4. Update the health endpoint to show Redis status:**

```js
app.get('/api/health', async (req, res) => {
  try {
    await redis.ping();
    res.json({ status: 'ok', redis: 'connected' });
  } catch {
    res.json({ status: 'ok', redis: 'disconnected' });
  }
});
```

**5. Test it:**

```bash
node server.js
```

You should see:
```
Connected to Redis
Server running on http://localhost:3000
```

In another terminal:
```bash
curl http://localhost:3000/api/health
```

Expected:
```json
{"status":"ok","redis":"connected"}
```

---

## Part 4: Store Users in Redis Hashes (~10 min)

Instead of `users.push(...)`, we'll store each user as a **Redis Hash**.

> **Redis Hashes** are like JavaScript objects — they map field names to values. Perfect for structured records like user profiles.

**1. Update the register route:**

Replace the in-memory user storage with Redis:

```js
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

  const hashedPassword = await bcrypt.hash(password, 10);

  // Store user as a Redis Hash: user:{username} -> { username, password }
  await redis.hSet(`user:${username}`, {
    username,
    password: hashedPassword,
  });

  res.status(201).json({ message: `User '${username}' registered successfully` });
});
```

**2. Update the login route:**

Replace `users.find(...)` with a Redis lookup:

```js
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  // Look up user from Redis Hash
  const storedPassword = await redis.hGet(`user:${username}`, 'password');
  if (!storedPassword) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const validPassword = await bcrypt.compare(password, storedPassword);
  if (!validPassword) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '15m' });
  const refreshToken = jwt.sign({ username }, REFRESH_SECRET, { expiresIn: '7d' });

  // Store refresh token in a Redis Set
  await redis.sAdd('refresh_tokens', refreshToken);

  res.json({ token, refreshToken });
});
```

**3. Test persistence:**

```bash
# Register a user
curl -X POST http://localhost:3000/api/register \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "password": "password123"}'

# Restart the server (Ctrl+C then node server.js again)

# Login - the user still exists!
curl -X POST http://localhost:3000/api/login \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "password": "password123"}'
```

With in-memory storage, this would fail after a restart. With Redis, the data persists!

---

## Part 5: Refresh Tokens in a Redis Set (~5 min)

Instead of `refreshTokens.push(...)` and `refreshTokens.includes(...)`, use a **Redis Set**.

> **Redis Sets** are unordered collections of unique strings. Perfect for token stores — fast O(1) membership checks.

**1. Update the refresh endpoint:**

```js
app.post('/api/refresh', async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(401).json({ error: 'Refresh token required' });
  }

  // Check if the refresh token is in our Redis Set
  const exists = await redis.sIsMember('refresh_tokens', refreshToken);
  if (!exists) {
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
```

**2. Update the logout endpoint:**

```js
app.post('/api/logout', async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    await redis.sRem('refresh_tokens', refreshToken);
  }
  res.json({ message: 'Logged out successfully' });
});
```

---

## Part 6: Add Caching (~15 min)

This is the core of the lab. We'll create two endpoints that return the same data — one with caching, one without — so you can see the speed difference.

**1. Create a simulated slow data source:**

```js
// Simulates a slow API call (e.g., complex database query or external API)
async function slowDataFetch(query) {
  await new Promise((resolve) => setTimeout(resolve, 2000)); // 2-second delay
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
```

**2. Add the uncached endpoint:**

```js
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
```

**3. Add the cached endpoint (the cache-aside pattern):**

```js
app.get('/api/data/cached', authenticateToken, async (req, res) => {
  const query = req.query.q || 'default';
  const cacheKey = `cache:data:${query}`;
  const start = Date.now();

  // Step 1: Check the cache
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

  // Step 2: Cache miss - fetch the slow way
  const data = await slowDataFetch(query);

  // Step 3: Store in Redis with a 30-second TTL
  await redis.set(cacheKey, JSON.stringify(data), { EX: 30 });

  const elapsed = Date.now() - start;
  res.json({
    ...data,
    responseTime: `${elapsed}ms`,
    source: 'direct (cache MISS - now cached for 30s)',
  });
});
```

**4. Add a cache-clearing endpoint:**

```js
app.post('/api/cache/clear', authenticateToken, async (req, res) => {
  const keys = await redis.keys('cache:*');
  if (keys.length > 0) {
    await redis.del(keys);
  }
  res.json({ message: `Cleared ${keys.length} cache entries` });
});
```

**5. Test the caching:**

```bash
# Login first
TOKEN=$(curl -s -X POST http://localhost:3000/api/login \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "password": "password123"}' | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

# No cache - always slow (~2000ms)
curl -s http://localhost:3000/api/data/no-cache?q=widgets \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# First cached call - slow (~2000ms, cache MISS)
curl -s http://localhost:3000/api/data/cached?q=widgets \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# Second cached call - instant! (~1-5ms, cache HIT)
curl -s http://localhost:3000/api/data/cached?q=widgets \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

Notice the massive speed difference: **~2000ms vs ~1-5ms** -- that's the power of caching!

---

## Part 7: Redis Data Explorer (~5 min)

Add an endpoint to see what's stored in Redis:

```js
app.get('/api/redis-info', async (req, res) => {
  const userKeys = await redis.keys('user:*');
  const refreshCount = await redis.sCard('refresh_tokens');
  const cacheKeys = await redis.keys('cache:*');

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
});
```

Test it:

```bash
curl -s http://localhost:3000/api/redis-info | python3 -m json.tool
```

You'll see how many users, refresh tokens, and cache entries are stored in Redis, along with the TTL (time remaining) for each cache entry.

---

## Part 8: Try the Web UI

Visit `http://localhost:3000` in your browser (or click the forwarded port URL in the Codespaces **Ports** tab).

The web UI lets you:
1. **Register and Login** - users persist in Redis across server restarts
2. **Access the protected route** - same JWT auth as before
3. **Compare cached vs uncached** - click both buttons and watch the response times
4. **Explore Redis data** - see what's stored in your Redis database

Try this sequence:
1. Register a user and login
2. Click "Fetch WITHOUT Cache" - notice it takes ~2 seconds
3. Click "Fetch WITH Cache" - first time is slow (MISS), second time is instant (HIT)
4. Watch the Redis Data Explorer update as cache entries appear
5. Wait 30 seconds and try again - the cache expires and you'll get another MISS

---

## Discussion Questions

1. **What is the cache-aside pattern?** How does it differ from write-through or write-behind caching?

2. **Why use a TTL on cache entries?** What happens if cached data never expires?

3. **What Redis data types did we use and why?**
   - Hashes for users
   - Sets for refresh tokens
   - Strings for cache entries

4. **What are the trade-offs of caching?** When would caching cause problems? (Hint: think about stale data)

5. **How does Redis persistence differ from a traditional database?** What happens if the Redis server restarts?

6. **Why is Redis so fast?** How does storing data in memory compare to disk-based databases?

7. **In production, what cache invalidation strategies would you use?** How would you handle updates to the underlying data?

---

## Submitting Your Work

Commit and push from the Codespace terminal:

```bash
git add -A
git commit -m "Complete Redis caching lab"
git push
```

---

## Automated Grading

When you push, an automated workflow runs 11 tests:

1. Health check returns 200 with Redis connected
2. Register a new user returns 201
3. Duplicate registration returns 409
4. Login with valid credentials returns 200 + token
5. Login with wrong password returns 401
6. Access protected route without token returns 401
7. Access protected route with valid token returns 200
8. Access protected route with garbage token returns 403
9. Cached endpoint returns data with source info
10. Second cached call is a cache HIT
11. Redis info endpoint shows stored data

Check the **Actions** tab in your repository for results.

---

## Codespaces Tips

- **Redis URL:** Set it as a Codespace secret (Settings > Secrets) so it's automatically available as an environment variable
- **Multiple terminals:** You'll need one running `node --watch server.js` and one for curl commands
- **Data persists:** Unlike the in-memory lab, your registered users survive server restarts (they're in Redis!)
- **Port forwarding:** Codespaces automatically forwards port 3000 for the web UI
