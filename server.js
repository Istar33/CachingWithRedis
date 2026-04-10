// Default entry point — runs the Redis version
// To compare, run the two servers side by side:
//   node server-memory.js    (port 3000 — in-memory, no caching)
//   node server-redis.js     (port 3001 — Redis-backed, with caching)

require('./server-redis.js');
