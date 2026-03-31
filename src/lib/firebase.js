import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

const firebaseConfig = {
  apiKey: 'AIzaSyA7ScJW4UKvFIsCCe7iuvFQlrtTsuKVhlc',
  authDomain: 'onetake-e2861.firebaseapp.com',
  projectId: 'onetake-e2861',
  storageBucket: 'onetake-e2861.firebasestorage.app',
  messagingSenderId: '202693996413',
  appId: '1:202693996413:web:0aac79833ef37e94e32614',
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

export default app;
