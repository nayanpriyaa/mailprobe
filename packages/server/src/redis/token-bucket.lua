-- Token bucket rate limiter. Atomic: read-refill-take-write happens in one script.
-- KEYS[1] bucket key
-- ARGV[1] capacity (burst size), ARGV[2] refill tokens/sec, ARGV[3] cost
-- Returns { allowed (0|1), remaining tokens (floor), retry_after_ms }
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local t = redis.call('TIME') -- server clock: no skew between API replicas
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1]) or capacity
local ts = tonumber(state[2]) or now
tokens = math.min(capacity, tokens + math.max(0, now - ts) * refill / 1000)

local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil((cost - tokens) * 1000 / refill)
end

redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
-- A full bucket is the default state, so the key can expire once it would be full again.
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity * 1000 / refill) + 1000)
return { allowed, math.floor(tokens), retry }
