# Lab: Caching with Redis

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/RPI-WS-spring-2026/CachingWithRedis)

This lab contains **two versions of the same application** — one using in-memory storage and one using Redis. You'll run both side by side to observe the differences in persistence, performance, and scalability.

**Time:** ~1 hour
**Environment:** GitHub Codespaces + Redis Cloud (free tier)

---

## The Two Servers

| | `server-memory.js` | `server-redis.js` |
|---|---|---|
| **Storage** | JavaScript arrays (`users = []`) | Redis Hashes, Sets, Strings |
| **Persistence** | Lost on every restart | Survives restarts |
| **Caching** | None — every request is slow | Cache-aside with 30s TTL |
| **Scalability** | Single process only | Shared across multiple processes |
| **Data inspection** | Not possible | `/api/redis-info` endpoint |

Both servers expose the **same API** — register, login, protected routes, and a simulated slow data endpoint. The only difference is what happens behind the scenes.

---

## Part 1: Set Up Redis Cloud (~10 min)

1. Go to [redis.io/try-free](https://redis.io/try-free/) and sign up (free, no credit card)
2. A free 30MB database is created automatically
3. From the dashboard, note your **Public endpoint** (host:port), **Username**, and **Password**

---

## Part 2: Open Your Codespace and Configure (~5 min)

1. Accept the GitHub Classroom assignment and open your Codespace
2. Copy the environment template and fill in your Redis credentials:

```bash
cp .env.example .env
```

Edit `.env`:
```
REDIS_URL=redis-14076.c232.us-east-1-2.ec2.cloud.redislabs.com:14076
REDIS_USER=default
REDIS_PASSWORD=your-password-here
```

3. Install dependencies:
```bash
npm install
```

---

## Part 3: Run Both Servers and Compare (~30 min)

### Experiment 1: Persistence

**Terminal 1 — In-memory server (port 3000):**
```bash
PORT=3000 node server-memory.js
```

**Terminal 2 — Redis server (port 3001):**
```bash
PORT=3001 node server-redis.js
```

**Terminal 3 — Test both:**
```bash
# Register a user on BOTH servers
curl -X POST http://localhost:3000/api/register \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "password": "pass123"}'

curl -X POST http://localhost:3001/api/register \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "password": "pass123"}'
```

Now **restart both servers** (Ctrl+C in terminals 1 and 2, then start them again).

```bash
# Try logging in on both
curl -X POST http://localhost:3000/api/login \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "password": "pass123"}'
# ^ FAILS — in-memory server lost all data

curl -X POST http://localhost:3001/api/login \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "password": "pass123"}'
# ^ WORKS — Redis persisted the user
```

### Experiment 2: Caching Performance

First, login to get a token from the Redis server:
```bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/login \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "password": "pass123"}' \
  | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
```

Also register and login on the memory server (since it lost data on restart):
```bash
curl -s -X POST http://localhost:3000/api/register \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "password": "pass123"}'

TOKEN_MEM=$(curl -s -X POST http://localhost:3000/api/login \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "password": "pass123"}' \
  | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
```

**Compare the "cached" endpoint on both servers:**

```bash
# In-memory server — always slow (~2000ms every time)
curl -s http://localhost:3000/api/data/cached?q=widgets \
  -H "Authorization: Bearer $TOKEN_MEM" | python3 -m json.tool

curl -s http://localhost:3000/api/data/cached?q=widgets \
  -H "Authorization: Bearer $TOKEN_MEM" | python3 -m json.tool

# Redis server — first call slow (MISS), second call instant (HIT)
curl -s http://localhost:3001/api/data/cached?q=widgets \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

curl -s http://localhost:3001/api/data/cached?q=widgets \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

**What you should observe:**
- In-memory: **~2000ms every time** — no caching possible
- Redis (1st call): **~2000ms** — cache MISS, fetches and stores result
- Redis (2nd call): **~1-5ms** — cache HIT, 400x faster

### Experiment 3: Cache Expiration

Wait 30 seconds after a cache HIT, then try again:

```bash
# This will be a MISS again — the TTL expired
curl -s http://localhost:3001/api/data/cached?q=widgets \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

You can watch the TTL count down:
```bash
curl -s http://localhost:3001/api/redis-info | python3 -m json.tool
```

### Experiment 4: Data Inspection

```bash
# In-memory server — no visibility into stored data
curl -s http://localhost:3000/api/redis-info | python3 -m json.tool

# Redis server — shows users, tokens, cache entries with TTLs
curl -s http://localhost:3001/api/redis-info | python3 -m json.tool
```
``
---

## Part 4: Explore the Web UI

Visit `http://localhost:3001` in your browser (the Redis server). The web UI lets you:

- Register and login (data persists across restarts)
- Compare cached vs uncached response times side by side
- Watch the Redis Data Explorer as entries are created and expire

Try the same at `http://localhost:3000` (the in-memory server) — notice the "cached" button is always slow.

---

## Part 5: Read the Code (~10 min)

Open `server-memory.js` and `server-redis.js` side by side. Focus on these differences:

**User storage:**
- Memory: `users.push({ username, password })` and `users.find(u => ...)`
- Redis: `redis.hSet('user:alice', { username, password })` and `redis.hGet('user:alice', 'password')`

**Refresh tokens:**
- Memory: `refreshTokens.push(token)` and `refreshTokens.includes(token)`
- Redis: `redis.sAdd('refresh_tokens', token)` and `redis.sIsMember('refresh_tokens', token)`

**Caching (only in Redis version):**
- Check: `redis.get(cacheKey)` — returns `null` on miss
- Store: `redis.set(cacheKey, data, { EX: 30 })` — auto-expires after 30 seconds
- This is the **cache-aside pattern** from the lecture

---

## Discussion Questions

1. **Persistence:** What happens to user sessions when you deploy a new version of your app? How does each server handle this differently?

2. **Horizontal scaling:** If you ran 3 copies of the in-memory server behind a load balancer, what would go wrong with user registration? How does Redis solve this?

3. **Cache TTL tradeoffs:** The lab uses a 30-second TTL. What would happen with a 1-second TTL? A 1-hour TTL? When is stale data acceptable?

4. **CAP theorem:** Where does Redis Cloud fall on the CAP triangle? When you read from the cache, are you choosing availability or consistency?

5. **Cost of caching:** The cache HIT is 400x faster, but what are the downsides? Think about stale data, memory cost, and invalidation complexity.

6. **Redis data types:** Why did we use a Hash for users, a Set for refresh tokens, and a String for cache entries? What properties of each data type make it the right fit?

---

## Submitting Your Work

```bash
git add -A
git commit -m "Complete Redis caching lab"
git push
```

---

## Automated Grading

When you push, an automated workflow runs 11 tests against the Redis server:

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

## Quick Reference

```bash
# Run in-memory server only
npm run start:memory

# Run Redis server only
npm run start:redis

# Run both side by side (ports 3000 and 3001)
npm run compare
```
