// Fake Firebase Auth: signed in as window.__H.user (admin claim from window.__H.admin).
const H = () => window.__H || {};
const listeners = new Set();
function makeUser() {
  const u = H().user;
  if (!u) return null;
  return { uid: u.uid, getIdToken: async () => 'fake-token', getIdTokenResult: async () => ({ claims: { admin: H().admin === true } }) };
}
const authObj = { currentUser: makeUser() };
export function getAuth() { authObj.currentUser = makeUser(); return authObj; }
export function onAuthStateChanged(a, cb) { listeners.add(cb); setTimeout(() => cb(authObj.currentUser), 0); return () => listeners.delete(cb); }
export async function signInWithEmailAndPassword() { throw Object.assign(new Error('Wrong username or password.'), { code: 'auth/invalid-credential' }); }
export async function signOut() { authObj.currentUser = null; listeners.forEach((cb) => cb(null)); }
