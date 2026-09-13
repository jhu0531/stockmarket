import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

// Firebase web config is not a secret (it's meant to be embedded client-side;
// access is controlled by Firebase Security Rules, not by hiding this).
const firebaseConfig = {
  apiKey: 'AIzaSyDSrtPLJezuy_cYdfVxLus8e_8sgTQ7h4U',
  authDomain: 'stockmarket-12a6a.firebaseapp.com',
  projectId: 'stockmarket-12a6a',
  storageBucket: 'stockmarket-12a6a.firebasestorage.app',
  messagingSenderId: '398996930311',
  appId: '1:398996930311:web:ceb8522ebf292acb6acfa2',
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

export function watchAuthState(callback) {
  onAuthStateChanged(auth, callback);
}

export function loginWithGoogle() {
  return signInWithPopup(auth, provider);
}

export function logout() {
  return firebaseSignOut(auth);
}

export function getIdToken() {
  return auth.currentUser ? auth.currentUser.getIdToken() : Promise.resolve(null);
}
