import {
  collection,
  doc,
  getDoc,
  increment,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from '../lib/firebase';

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function normalizeResponse(docSnap) {
  return { id: docSnap.id, ...docSnap.data() };
}

export async function createResponseFromTake({
  responseId,
  recipient,
  user,
  downloadURL,
  storagePath,
  localUri,
  durationSeconds,
}) {
  const responseRef = doc(db, 'responses', responseId);
  await setDoc(responseRef, {
    responseId,
    promptId: recipient.promptId,
    promptTemplateId: recipient.promptTemplateId || null,
    uid: user.uid,
    visibility: 'friends',
    videoUrl: downloadURL || '',
    storagePath: storagePath || '',
    localUri: localUri || '',
    durationSeconds: durationSeconds || 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    createdAtClient: Date.now(),
    deletedAtClient: null,
    status: 'ready',
    reactionCounts: {
      like: 0,
      laugh: 0,
      crazy: 0,
      fire: 0,
      respect: 0,
    },
    promptTextSnapshot: recipient.promptTextSnapshot,
    promptIssuedAtClient: recipient.startAtClient,
    authorDisplayNameSnapshot: user.displayName || user.email || 'User',
    authorUsernameSnapshot: user.username || '',
    authorPhotoURLSnapshot: user.photoURL || '',
  });

  await updateDoc(doc(db, 'users', user.uid), {
    responseCount: increment(1),
    'statsHidden.totalPromptsCompleted': increment(1),
    updatedAt: serverTimestamp(),
  });
}

export async function deleteResponse(responseId) {
  await updateDoc(doc(db, 'responses', responseId), {
    status: 'deleted',
    deletedAtClient: Date.now(),
    updatedAt: serverTimestamp(),
  });
}

export function subscribeFeedResponses(visibleUserIds, onData, onError) {
  const ids = Array.from(new Set((visibleUserIds || []).filter(Boolean)));
  if (ids.length === 0) {
    onData([]);
    return () => {};
  }

  const chunks = chunk(ids, 10);
  const state = new Map();

  const emit = () => {
    const merged = [];
    state.forEach((items) => merged.push(...items));
    const unique = Array.from(new Map(merged.map((item) => [item.id, item])).values())
      .filter((item) => item.status === 'ready' && !item.deletedAtClient)
      .sort((a, b) => (b.promptIssuedAtClient || 0) - (a.promptIssuedAtClient || 0) || (b.createdAtClient || 0) - (a.createdAtClient || 0));
    onData(unique);
  };

  const unsubs = chunks.map((chunkIds, index) =>
    onSnapshot(
      query(collection(db, 'responses'), where('uid', 'in', chunkIds)),
      (snap) => {
        state.set(index, snap.docs.map(normalizeResponse));
        emit();
      },
      onError
    )
  );

  return () => unsubs.forEach((unsub) => unsub());
}

export function subscribeUserResponses(uid, onData, onError) {
  return onSnapshot(
    query(collection(db, 'responses'), where('uid', '==', uid)),
    (snap) => {
      const items = snap.docs
        .map(normalizeResponse)
        .filter((item) => item.status === 'ready' && !item.deletedAtClient)
        .sort((a, b) => (b.createdAtClient || 0) - (a.createdAtClient || 0));
      onData(items);
    },
    onError
  );
}

export async function getResponse(responseId) {
  const snap = await getDoc(doc(db, 'responses', responseId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}
