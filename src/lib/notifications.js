import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from './firebase';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

function getProjectId() {
  return (
    Constants?.expoConfig?.extra?.eas?.projectId ||
    Constants?.easConfig?.projectId ||
    null
  );
}

export async function registerDeviceForPushNotifications(uid) {
  if (!uid) return { token: null, status: 'missing_uid', requested: false };
  if (!Device.isDevice) return { token: null, status: 'simulator', requested: false };

  const projectId = getProjectId();

  if (!projectId) {
    console.log('Missing EAS projectId for push notifications.');
    return { token: null, status: 'missing_project_id', requested: false };
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FFC21F',
    });
  }

  const currentPermissions = await Notifications.getPermissionsAsync();
  let finalStatus = currentPermissions.status;
  let requested = false;

  if (finalStatus !== 'granted') {
    requested = true;
    const requestedPermissions = await Notifications.requestPermissionsAsync();
    finalStatus = requestedPermissions.status;
  }

  if (finalStatus !== 'granted') {
    console.log('Push notification permission not granted.');
    return { token: null, status: finalStatus || 'not_granted', requested };
  }

  const tokenResponse = await Notifications.getExpoPushTokenAsync({ projectId });
  const token = tokenResponse?.data;

  if (!token) return { token: null, status: 'missing_token', requested };

  await setDoc(
    doc(db, 'pushTokens', encodeURIComponent(token)),
    {
      uid,
      token,
      platform: Platform.OS,
      deviceName: Device.deviceName || '',
      projectId,
      isActive: true,
      updatedAt: serverTimestamp(),
      createdAtClient: Date.now(),
    },
    { merge: true }
  );

  return { token, status: finalStatus, requested };
}

function extractNotificationData(response) {
  return response?.notification?.request?.content?.data || {};
}

export function registerNotificationTapHandler(onTap) {
  let removed = false;

  Notifications.getLastNotificationResponseAsync()
    .then((response) => {
      if (removed || !response) return;
      const data = extractNotificationData(response);
      if (data && Object.keys(data).length > 0) onTap?.(data);
    })
    .catch((error) => console.log('initial notification response failed', error?.message || error));

  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = extractNotificationData(response);
    onTap?.(data);
  });

  return () => {
    removed = true;
    subscription.remove();
  };
}
