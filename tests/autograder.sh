#!/bin/bash
# Autograder for Redis Caching Lab
# Tests authentication (stored in Redis) and caching functionality

BASE_URL="http://localhost:3000"
PASSED=0
FAILED=0

pass() {
  echo "PASS: $1"
  PASSED=$((PASSED + 1))
}

fail() {
  echo "FAIL: $1"
  FAILED=$((FAILED + 1))
}

# --- Test 1: Health check returns 200 and shows Redis connected ---
HEALTH_RESPONSE=$(curl -s "$BASE_URL/api/health")
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/health")
REDIS_STATUS=$(echo "$HEALTH_RESPONSE" | grep -o '"redis":"connected"')
if [ "$STATUS" = "200" ] && [ -n "$REDIS_STATUS" ]; then
  pass "Health check returns 200 with Redis connected"
else
  fail "Health check returns 200 with Redis connected (status=$STATUS, response=$HEALTH_RESPONSE)"
fi

# --- Test 2: Register a new user returns 201 ---
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/register" \
  -H "Content-Type: application/json" \
  -d '{"username": "testuser", "password": "testpass123"}')
if [ "$STATUS" = "201" ]; then
  pass "Register a new user returns 201"
else
  fail "Register a new user returns 201 (got $STATUS)"
fi

# --- Test 3: Duplicate registration returns 409 ---
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/register" \
  -H "Content-Type: application/json" \
  -d '{"username": "testuser", "password": "testpass123"}')
if [ "$STATUS" = "409" ]; then
  pass "Duplicate registration returns 409"
else
  fail "Duplicate registration returns 409 (got $STATUS)"
fi

# --- Test 4: Login with valid credentials returns 200 + token ---
LOGIN_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/api/login" \
  -H "Content-Type: application/json" \
  -d '{"username": "testuser", "password": "testpass123"}')
LOGIN_STATUS=$(echo "$LOGIN_RESPONSE" | tail -1)
LOGIN_BODY=$(echo "$LOGIN_RESPONSE" | sed '$d')
TOKEN=$(echo "$LOGIN_BODY" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ "$LOGIN_STATUS" = "200" ] && [ -n "$TOKEN" ]; then
  pass "Login with valid credentials returns 200 + token"
else
  fail "Login with valid credentials returns 200 + token (status=$LOGIN_STATUS, token=${TOKEN:-(empty)})"
fi

# --- Test 5: Login with wrong password returns 401 ---
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/login" \
  -H "Content-Type: application/json" \
  -d '{"username": "testuser", "password": "wrongpassword"}')
if [ "$STATUS" = "401" ]; then
  pass "Login with wrong password returns 401"
else
  fail "Login with wrong password returns 401 (got $STATUS)"
fi

# --- Test 6: Access protected route without token returns 401 ---
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/secret")
if [ "$STATUS" = "401" ]; then
  pass "Access protected route without token returns 401"
else
  fail "Access protected route without token returns 401 (got $STATUS)"
fi

# --- Test 7: Access protected route with valid token returns 200 ---
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/secret" \
  -H "Authorization: Bearer $TOKEN")
if [ "$STATUS" = "200" ]; then
  pass "Access protected route with valid token returns 200"
else
  fail "Access protected route with valid token returns 200 (got $STATUS)"
fi

# --- Test 8: Access protected route with garbage token returns 403 ---
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/secret" \
  -H "Authorization: Bearer not.a.real.token")
if [ "$STATUS" = "403" ]; then
  pass "Access protected route with garbage token returns 403"
else
  fail "Access protected route with garbage token returns 403 (got $STATUS)"
fi

# --- Test 9: Cached endpoint returns data with source field ---
CACHED_RESPONSE=$(curl -s "$BASE_URL/api/data/cached?q=test" \
  -H "Authorization: Bearer $TOKEN")
CACHED_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/data/cached?q=test" \
  -H "Authorization: Bearer $TOKEN")
HAS_SOURCE=$(echo "$CACHED_RESPONSE" | grep -o '"source"')
if [ "$CACHED_STATUS" = "200" ] && [ -n "$HAS_SOURCE" ]; then
  pass "Cached endpoint returns data with cache source info"
else
  fail "Cached endpoint returns data with cache source info (status=$CACHED_STATUS)"
fi

# --- Test 10: Second cached call is a cache HIT ---
# The first call above was a MISS, this should be a HIT
CACHED_RESPONSE2=$(curl -s "$BASE_URL/api/data/cached?q=test" \
  -H "Authorization: Bearer $TOKEN")
HAS_HIT=$(echo "$CACHED_RESPONSE2" | grep -o 'HIT')
if [ -n "$HAS_HIT" ]; then
  pass "Second cached call returns cache HIT"
else
  fail "Second cached call returns cache HIT (response=$CACHED_RESPONSE2)"
fi

# --- Test 11: Redis info endpoint shows stored data ---
INFO_RESPONSE=$(curl -s "$BASE_URL/api/redis-info")
HAS_USERS=$(echo "$INFO_RESPONSE" | grep -o '"users"')
HAS_CACHE=$(echo "$INFO_RESPONSE" | grep -o '"cacheEntries"')
if [ -n "$HAS_USERS" ] && [ -n "$HAS_CACHE" ]; then
  pass "Redis info endpoint shows stored data"
else
  fail "Redis info endpoint shows stored data (response=$INFO_RESPONSE)"
fi

# --- Summary ---
echo ""
echo "================================"
echo "Results: $PASSED passed, $FAILED failed (out of 11)"
echo "================================"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
