// =============================================================================
// In My Pocket — admin CLI.
//
// Talks to the DB directly (not via HTTP). Out-of-band by design —
// keeps invite minting and user resets off the public network surface.
//
// Usage (eventual):
//   node platform/cli.js invite mint --uses 1 --note "for alice"
//   node platform/cli.js invite list --active
//   node platform/cli.js invite revoke <code>
//   node platform/cli.js user reset-password <username>
//   node platform/cli.js db migrate
// =============================================================================

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log("usage: cli <invite|user|db> <subcommand> [...]");
  process.exit(1);
}

// TODO: dispatch by subcommand. See docs/multi-game-platform.md §6.2.5.
console.log("[cli] not implemented:", args.join(" "));
process.exit(1);
