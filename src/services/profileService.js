import { db } from '../lib/firebase';
import { doc, getDoc, onSnapshot, setDoc, serverTimestamp, updateDoc } from 'firebase/firestore';

export function subscribeToProfile(userId, onData, onError) {
  const ref = doc(db, 'users', userId);
  return onSnapshot(ref, (snap) => onData(snap.exists() ? snap.data() : null), onError);
}

export async function ensureUserProfile(user) {
  const ref = doc(db, 'users', user.uid);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    await setDoc(ref, {
      email: user.email || '',
      role: 'user',
      createdAt: serverTimestamp(),
      lastSeenAt: serverTimestamp(),
      pushToken: '',
    });
  } else {
    await updateDoc(ref, {
      lastSeenAt: serverTimestamp(),
    });
  }
}

export async function setPushToken(userId, token) {
  const ref = doc(db, 'users', userId);
  await updateDoc(ref, { pushToken: token || '' });
}
