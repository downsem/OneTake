import {
  doc,
  getDoc,
  getDocs,
  collection,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  startAt,
  endAt,
  updateDoc,
} from 'firebase/firestore';
import { db } from '../lib/firebase';

export function subscribeToProfile(userId, onData, onError) {
  const ref = doc(db, 'users', userId);
  return onSnapshot(ref, (snap) => onData(snap.exists() ? { id: snap.id, ...snap.data() } : null), onError);
}

export async function getProfileById(userId) {
  if (!userId) return null;
  const snap = await getDoc(doc(db, 'users', userId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function ensureUserProfile(user) {
  const ref = doc(db, 'users', user.uid);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    await setDoc(ref, {
      uid: user.uid,
      email: user.email || '',
      role: 'user',
      displayName: user.displayName || '',
      photoURL: user.photoURL || '',
      bio: '',
      username: '',
      usernameLower: '',
      friendCount: 0,
      responseCount: 0,
      statsHidden: {
        totalPromptsOpened: 0,
        totalPromptsForfeited: 0,
        totalPromptsCompleted: 0,
        totalReactionsReceived: 0,
      },
      createdAt: serverTimestamp(),
      createdAtClient: Date.now(),
      updatedAt: serverTimestamp(),
      lastSeenAt: serverTimestamp(),
    });
    return;
  }

  await updateDoc(ref, {
    email: user.email || snap.data()?.email || '',
    updatedAt: serverTimestamp(),
    lastSeenAt: serverTimestamp(),
  });
}

export function isProfileComplete(profile) {
  return !!profile?.usernameLower && !!profile?.displayName;
}

export function sanitizeUsername(username) {
  return (username || '').trim().toLowerCase().replace(/[^a-z0-9._]/g, '');
}

export async function saveProfileSetup({ uid, email, username, displayName, bio = '', photoURL = '' }) {
  const usernameLower = sanitizeUsername(username);
  if (!uid) throw new Error('Missing uid.');
  if (!usernameLower || usernameLower.length < 3 || usernameLower.length > 20) {
    throw new Error('Username must be 3–20 characters and use letters, numbers, periods, or underscores.');
  }
  if (!displayName?.trim()) throw new Error('Display name is required.');

  const userRef = doc(db, 'users', uid);
  const usernameRef = doc(db, 'usernames', usernameLower);

  await runTransaction(db, async (tx) => {
    const userSnap = await tx.get(userRef);
    const usernameSnap = await tx.get(usernameRef);

    const userData = userSnap.exists() ? userSnap.data() : {};
    const previousUsernameLower = userData?.usernameLower || '';

    if (usernameSnap.exists() && usernameSnap.data()?.uid !== uid) {
      throw new Error('That username is already taken.');
    }

    tx.set(
      userRef,
      {
        uid,
        email: email || userData?.email || '',
        username: usernameLower,
        usernameLower,
        displayName: displayName.trim(),
        bio: bio || '',
        photoURL: photoURL || userData?.photoURL || '',
        updatedAt: serverTimestamp(),
        lastSeenAt: serverTimestamp(),
      },
      { merge: true }
    );

    tx.set(
      usernameRef,
      {
        uid,
        username: usernameLower,
        createdAtClient: userData?.createdAtClient || Date.now(),
      },
      { merge: true }
    );

    if (previousUsernameLower && previousUsernameLower !== usernameLower) {
      tx.delete(doc(db, 'usernames', previousUsernameLower));
    }
  });
}

export async function updateProfileBasics(uid, updates) {
  const ref = doc(db, 'users', uid);
  await updateDoc(ref, {
    ...updates,
    updatedAt: serverTimestamp(),
  });
}


export async function searchUsersByUsername(term) {
  const cleaned = sanitizeUsername(term);
  if (!cleaned) return [];

  const q = query(
    collection(db, 'users'),
    orderBy('usernameLower'),
    startAt(cleaned),
    endAt(`${cleaned}\uf8ff`)
  );

  const snap = await getDocs(q);
  return snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
}