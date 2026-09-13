// ---------------------------------------------------------------------------
// voice-synthesize — entry shim.
//
// The Freebuff bundler treats source/index.ts as the entry point and only
// packages files inside this function package directory; this shim keeps the
// standard Supabase CLI deploy path (`supabase functions deploy`) working too.
// ---------------------------------------------------------------------------

import "./source/index.ts";
