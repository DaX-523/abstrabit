// No-op stand-in for the "server-only" package under Vitest (plain Node),
// which otherwise throws unconditionally since it relies on Next's bundler
// export-condition resolution to become a no-op. See vitest.config.ts.
export {};
