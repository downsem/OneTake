import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from '../lib/firebase';

export function friendshipKey(uidA, uidB) {
  return [uidA, uidB].sort().join('__');
}

async function hydrateUsers(items, pickOtherUid) {
  const users = await Promise.all(
    items.map(async (item) => {
      const targetUid = pickOtherUid(item);
      const snap = await getDoc(doc(db, 'users', targetUid));
      return {
        ...item,
        user: snap.exists() ? { id: snap.id, ...snap.data() } : null,
      };
    })
  );
  return users.filter((item) => item.user);
}

export function subscribeToFriendships(currentUid, onData, onError) {
  const q = query(collection(db, 'friendships'), where('users', 'array-contains', currentUid));
  return onSnapshot(
    q,
    async (snap) => {
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const hydrated = await hydrateUsers(items, (item) => item.users.find((uid) => uid !== currentUid));
      onData(hydrated);
    },
    onError
  );
}

export function subscribeToIncomingRequests(currentUid, onData, onError) {
  const q = query(collection(db, 'friendRequests'), where('toUid', '==', currentUid));
  return onSnapshot(
    q,
    async (snap) => {
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((item) => item.status === 'pending');
      const hydrated = await hydrateUsers(items, (item) => item.fromUid);
      onData(hydrated);
    },
    onError
  );
}

export function subscribeToOutgoingRequests(currentUid, onData, onError) {
  const q = query(collection(db, 'friendRequests'), where('fromUid', '==', currentUid));
  return onSnapshot(
    q,
    async (snap) => {
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((item) => item.status === 'pending');
      const hydrated = await hydrateUsers(items, (item) => item.toUid);
      onData(hydrated);
    },
    onError
  );
}

export async function sendFriendRequest(fromUid, toUid) {
  if (!fromUid || !toUid) throw new Error('Missing user ids.');
  if (fromUid === toUid) throw new Error('You cannot add yourself.');
  const requestId = friendshipKey(fromUid, toUid);
  const requestRef = doc(db, 'friendRequests', requestId);
  const friendshipRef = doc(db, 'friendships', requestId);

  await runTransaction(db, async (tx) => {
    const [requestSnap, friendshipSnap] = await Promise.all([tx.get(requestRef), tx.get(friendshipRef)]);
    if (friendshipSnap.exists()) throw new Error('You are already friends.');

    if (requestSnap.exists()) {
      const existing = requestSnap.data();
      if (existing.status === 'pending') {
        if (existing.fromUid === toUid && existing.toUid === fromUid) {
          tx.update(requestRef, {
            status: 'accepted',
            updatedAt: serverTimestamp(),
          });
          tx.set(friendshipRef, {
            users: [fromUid, toUid].sort(),
            createdAt: serverTimestamp(),
            createdAtClient: Date.now(),
          });
          const fromUserRef = doc(db, 'users', fromUid);
          const toUserRef = doc(db, 'users', toUid);
          const [fromUserSnap, toUserSnap] = await Promise.all([tx.get(fromUserRef), tx.get(toUserRef)]);
          tx.set(fromUserRef, { friendCount: (fromUserSnap.data()?.friendCount || 0) + 1 }, { merge: true });
          tx.set(toUserRef, { friendCount: (toUserSnap.data()?.friendCount || 0) + 1 }, { merge: true });
          return;
        }
        throw new Error('Friend request already pending.');
      }
    }

    tx.set(requestRef, {
      fromUid,
      toUid,
      status: 'pending',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdAtClient: Date.now(),
    });
  });
}

export async function acceptFriendRequest(requestId) {
  const requestRef = doc(db, 'friendRequests', requestId);
  const friendshipRef = doc(db, 'friendships', requestId);

  await runTransaction(db, async (tx) => {
    const requestSnap = await tx.get(requestRef);
    if (!requestSnap.exists()) throw new Error('Request not found.');
    const request = requestSnap.data();
    if (request.status !== 'pending') return;

    tx.update(requestRef, {
      status: 'accepted',
      updatedAt: serverTimestamp(),
    });

    tx.set(friendshipRef, {
      users: [request.fromUid, request.toUid].sort(),
      createdAt: serverTimestamp(),
      createdAtClient: Date.now(),
    });

    const fromUserRef = doc(db, 'users', request.fromUid);
    const toUserRef = doc(db, 'users', request.toUid);
    const [fromUserSnap, toUserSnap] = await Promise.all([tx.get(fromUserRef), tx.get(toUserRef)]);
    tx.set(fromUserRef, { friendCount: (fromUserSnap.data()?.friendCount || 0) + 1 }, { merge: true });
    tx.set(toUserRef, { friendCount: (toUserSnap.data()?.friendCount || 0) + 1 }, { merge: true });
  });
}

export async function declineFriendRequest(requestId) {
  await updateDoc(doc(db, 'friendRequests', requestId), {
    status: 'declined',
    updatedAt: serverTimestamp(),
  });
}

export async function cancelFriendRequest(requestId) {
  await updateDoc(doc(db, 'friendRequests', requestId), {
    status: 'cancelled',
    updatedAt: serverTimestamp(),
  });
}

export async function getFriendIds(currentUid) {
  const snap = await getDocs(query(collection(db, 'friendships'), where('users', 'array-contains', currentUid)));
  return snap.docs.map((d) => d.data().users.find((uid) => uid !== currentUid)).filter(Boolean);
}
