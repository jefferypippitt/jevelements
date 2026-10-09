// The run log and capture staging exist for local development only. A deployed backend
// (NODE_ENV=production) writes nothing to disk, so it never keeps the pages users capture or the
// files on them. Read at call time so tests can switch modes.
export function storesLocally(): boolean {
  return process.env.NODE_ENV !== 'production'
}

export const NOT_STORED = 'This backend only stores captures in local development'
