export { parseAddress, normalizeDomain, type ParsedAddress, type ParseResult, type SyntaxErrorCode } from './syntax.js';
export { suggestDomain, boundedOsaDistance } from './typo.js';
export { DomainSet, loadDisposableDomains } from './disposable.js';
export { FREE_PROVIDERS, ROLE_LOCALS, POPULAR_DOMAINS } from './lists.js';
export {
  DnsMxResolver,
  StaticMxResolver,
  systemDnsBackend,
  type DnsBackend,
  type MxHost,
  type MxLookup,
  type MxResolver,
  type SystemDnsOptions,
} from './dns.js';
export { SmtpConnection, SmtpFailure, type SmtpReply } from './smtp/connection.js';
export {
  probeDomain,
  DEFAULT_PROBE_OPTIONS,
  type DomainProbeResult,
  type ProbeOptions,
  type RcptOutcome,
} from './smtp/probe.js';
export { InMemoryHostLimiter, type HostLimiter, type Release } from './limiter.js';
export {
  classifyRcptReply,
  classifyOutcome,
  score,
  type Verdict,
  type VerificationReason,
  type VerificationStatus,
} from './classify.js';
export {
  Verifier,
  DEFAULT_VERIFIER_OPTIONS,
  type VerificationResult,
  type VerifierDeps,
  type VerifierMetrics,
  type VerifierOptions,
} from './verifier.js';
export { InMemoryCache, mapLimit, type VerifierCache } from './util.js';
