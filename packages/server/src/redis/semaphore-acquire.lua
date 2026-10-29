-- Distributed counting semaphore (one per MX host) shared by all workers.
-- Holders are a sorted set scored by acquisition time; holders older than the
-- lease are presumed dead (worker crashed mid-session) and evicted, so a crash
-- can never leak a slot permanently.
-- KEYS[1] semaphore key
-- ARGV[1] limit, ARGV[2] lease ms, ARGV[3] holder token
-- Returns 1 if acquired, 0 otherwise.
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local lease = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - lease)
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[1]) then
  redis.call('ZADD', KEYS[1], now, ARGV[3])
  redis.call('PEXPIRE', KEYS[1], lease)
  return 1
end
return 0
