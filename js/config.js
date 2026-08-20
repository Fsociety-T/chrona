/* ═══════════════════════════════════════════════════════════════
   config.js — Supabase connection defaults

   These are safe to commit and safe to ship inside the APK. The anon
   key identifies the *project*, not you: it carries `role: anon` and
   grants nothing on its own. Row-level security in supabase/schema.sql
   is what protects your rows — every table is restricted to
   `auth.uid() = user_id`, so an anonymous caller sees nothing.

   Never put the `service_role` key here. That one bypasses RLS.

   Anything the user enters in Settings → Cloud sync overrides these.
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  global.CHRONA_CONFIG = {
    SUPABASE_URL: 'https://awgwmedkmmcpfvtlsfta.supabase.co',
    SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF3Z3dtZWRrbW1jcGZ2dGxzZnRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY5ODg4NzAsImV4cCI6MjEwMjU2NDg3MH0.KyHE9W9K7ngBGv12F7RqJChMNi9nJujAQp6PS4lJ3gM'
  };
})(window);
