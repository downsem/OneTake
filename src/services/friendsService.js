import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  increment,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { db } from '../lib/firebase';

function friendshipIdFor(uidA, uidB) {
  return [uidA, uidB].sort().join('_');
}

function requestIdFor(fromUid, toUid) {
  return `${fromUid}_${toUid}`;
}

function blockIdFor(blockerUid, blockedUid) {
  return `${blockerUid}_${blockedUid}`;
}

async function getUserProfile(uid) {
  if (!uid) return null;
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : { id: uid };
}

async function hydrateUserRows(snap, currentUid, otherUidGetter) {
  const rows = await Promise.all(
    snap.docs.map(async (d) => {
      const data = d.data();
      const otherUid = otherUidGetter(data);
      const user = await getUserProfile(otherUid);
      return { id: d.id, ...data, user };
    })
  );

  return rows.filter((row) => row.user?.id && row.user.id !== currentUid);
}

export function subscribeToFriendships(uid, onData, onError) {
  const q = query(collection(db, 'friendships'), where('users', 'array-contains', uid));

  return onSnapshot(
    q,
    async (snap) => {
      try {
        const rows = await hydrateUserRows(snap, uid, (data) =>
          (data.users || []).find((userId) => userId !== uid)
        );
        onData(rows);
      } catch (error) {
        onError?.(error);
      }
    },
    onError
  );
}

export function subscribeToIncomingRequests(uid, onData, onError) {
  const q = query(
    collection(db, 'friendRequests'),
    where('toUid', '==', uid),
    where('status', '==', 'pending')
  );

  return onSnapshot(
    q,
    async (snap) => {
      try {
        const rows = await hydrateUserRows(snap, uid, (data) => data.fromUid);
        onData(rows);
      } catch (error) {
        onError?.(error);
      }
    },
    onError
  );
}

export function subscribeToOutgoingRequests(uid, onData, onError) {
  const q = query(
    collection(db, 'friendRequests'),
    where('fromUid', '==', uid),
    where('status', '==', 'pending')
  );

  return onSnapshot(
    q,
    async (snap) => {
      try {
        const rows = await hydrateUserRows(snap, uid, (data) => data.toUid);
        onData(rows);
      } catch (error) {
        onError?.(error);
      }
    },
    onError
  );
}

export function subscribeToOutgoingBlocks(uid, onData, onError) {
  const q = query(collection(db, 'blocks'), where('blockerUid', '==', uid));
  return onSnapshot(
    q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError
  );
}

export function subscribeToIncomingBlocks(uid, onData, onError) {
  const q = query(collection(db, 'blocks'), where('blockedUid', '==', uid));
  return onSnapshot(
    q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError
  );
}

export async function sendFriendRequest(fromUid, toUid) {
  if (!fromUid || !toUid) throw new Error('Missing user id.');
  if (fromUid === toUid) throw new Error('You cannot add yourself.');

  const friendshipRef = doc(db, 'friendships', friendshipIdFor(fromUid, toUid));
  const outgoingRef = doc(db, 'friendRequests', requestIdFor(fromUid, toUid));
  const reverseRef = doc(db, 'friendRequests', requestIdFor(toUid, fromUid));
  const outgoingBlockRef = doc(db, 'blocks', blockIdFor(fromUid, toUid));
  const incomingBlockRef = doc(db, 'blocks', blockIdFor(toUid, fromUid));

  await runTransaction(db, async (tx) => {
    const [friendshipSnap, outgoingSnap, reverseSnap, outgoingBlockSnap, incomingBlockSnap] =
      await Promise.all([
        tx.get(friendshipRef),
        tx.get(outgoingRef),
        tx.get(reverseRef),
        tx.get(outgoingBlockRef),
        tx.get(incomingBlockRef),
      ]);

    if (friendshipSnap.exists()) throw new Error('You are already friends.');
    if (outgoingBlockSnap.exists()) throw new Error('You blocked this user.');
    if (incomingBlockSnap.exists()) throw new Error('This user is unavailable.');
    if (outgoingSnap.exists() && outgoingSnap.data()?.status === 'pending') {
      throw new Error('Friend request already sent.');
    }
    if (reverseSnap.exists() && reverseSnap.data()?.status === 'pending') {
      throw new Error('This user already requested you.');
    }

    tx.set(outgoingRef, {
      fromUid,
      toUid,
      users: [fromUid, toUid],
      status: 'pending',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdAtClient: Date.now(),
    });
  });
}

export async function cancelFriendRequest(requestId) {
  await updateDoc(doc(db, 'friendRequests', requestId), {
    status: 'cancelled',
    updatedAt: serverTimestamp(),
  });
}

export async function declineFriendRequest(requestId) {
  await updateDoc(doc(db, 'friendRequests', requestId), {
    status: 'declined',
    updatedAt: serverTimestamp(),
  });
}

export async function acceptFriendRequest(requestId) {
  const requestRef = doc(db, 'friendRequests', requestId);

  await runTransaction(db, async (tx) => {
    const requestSnap = await tx.get(requestRef);
    if (!requestSnap.exists()) throw new Error('Friend request not found.');

    const request = requestSnap.data();
    if (request.status !== 'pending') throw new Error('This request is no longer pending.');

    const fromUid = request.fromUid;
    const toUid = request.toUid;
    const friendshipRef = doc(db, 'friendships', friendshipIdFor(fromUid, toUid));

    tx.set(friendshipRef, {
      users: [fromUid, toUid],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdAtClient: Date.now(),
    });

    tx.update(requestRef, {
      status: 'accepted',
      updatedAt: serverTimestamp(),
    });

    tx.set(
      doc(db, 'users', fromUid),
      { friendCount: increment(1), updatedAt: serverTimestamp() },
      { merge: true }
    );
    tx.set(
      doc(db, 'users', toUid),
      { friendCount: increment(1), updatedAt: serverTimestamp() },
      { merge: true }
    );
  });
}

export async function removeFriend(currentUid, targetUid) {
  if (!currentUid || !targetUid) throw new Error('Missing user id.');

  const friendshipRef = doc(db, 'friendships', friendshipIdFor(currentUid, targetUid));

  await runTransaction(db, async (tx) => {
    const friendshipSnap = await tx.get(friendshipRef);
    if (!friendshipSnap.exists()) return;

    tx.delete(friendshipRef);
    tx.set(
      doc(db, 'users', currentUid),
      { friendCount: increment(-1), updatedAt: serverTimestamp() },
      { merge: true }
    );
    tx.set(
      doc(db, 'users', targetUid),
      { friendCount: increment(-1), updatedAt: serverTimestamp() },
      { merge: true }
    );
  });
}

export async function blockUser(blockerUid, blockedUid) {
  if (!blockerUid || !blockedUid) throw new Error('Missing user id.');
  if (blockerUid === blockedUid) throw new Error('You cannot block yourself.');

  const batch = writeBatch(db);
  const now = Date.now();

  batch.set(doc(db, 'blocks', blockIdFor(blockerUid, blockedUid)), {
    blockerUid,
    blockedUid,
    users: [blockerUid, blockedUid],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    createdAtClient: now,
  });

  batch.delete(doc(db, 'friendships', friendshipIdFor(blockerUid, blockedUid)));
  batch.delete(doc(db, 'friendRequests', requestIdFor(blockerUid, blockedUid)));
  batch.delete(doc(db, 'friendRequests', requestIdFor(blockedUid, blockerUid)));

  await batch.commit();
}

export async function unblockUser(blockerUid, blockedUid) {
  if (!blockerUid || !blockedUid) throw new Error('Missing user id.');
  await deleteDoc(doc(db, 'blocks', blockIdFor(blockerUid, blockedUid)));
}
