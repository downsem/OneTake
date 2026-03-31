import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { storage } from './firebase';

export async function uploadVideoForResponse({ userId, responseId, localUri }) {
  if (!userId) throw new Error('Missing userId');
  if (!responseId) throw new Error('Missing responseId');
  if (!localUri) throw new Error('Missing localUri');

  const response = await fetch(localUri);
  const blob = await response.blob();

  const storagePath = `responses/${userId}/${responseId}.mp4`;
  const fileRef = ref(storage, storagePath);

  await uploadBytes(fileRef, blob, { contentType: 'video/mp4' });
  const downloadURL = await getDownloadURL(fileRef);

  return { storagePath, downloadURL };
}
