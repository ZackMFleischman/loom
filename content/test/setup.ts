/**
 * Content-test setup: happy-dom forwards fetch() to the REAL network (loaders
 * like GLTFLoader fetch their URL at build time), which spams ECONNREFUSED
 * noise into every run. There is no server in these tests by design — answer
 * every fetch with an instant 404 so async loaders fail fast and quietly
 * through their own error paths.
 */
globalThis.fetch = (() =>
  Promise.resolve(new Response(null, { status: 404, statusText: "no network in content tests" }))) as typeof fetch;
