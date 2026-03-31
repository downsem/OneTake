import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { auth, db } from './src/lib/firebase';
import { uploadVideoForUser } from './src/lib/storage';

import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';

import {
  addDoc,
  collection,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
} from 'firebase/firestore';

export default function App() {
  const [screen, setScreen] = useState('home'); // home | camera | takes

  // Auth
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState('signin'); // signin | signup
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);

  // Takes
  const [takes, setTakes] = useState([]);
  const [takesLoading, setTakesLoading] = useState(false);

  // Camera
  const [isRecording, setIsRecording] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef(null);

  // ---------- AUTH LISTENER ----------
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser || null);
      setAuthLoading(false);
    });
    return unsub;
  }, []);

  // ---------- TAKES LISTENER ----------
  useEffect(() => {
    if (!user?.uid) {
      setTakes([]);
      return;
    }

    setTakesLoading(true);

    const takesRef = collection(db, 'users', user.uid, 'takes');
    const q = query(takesRef, orderBy('createdAtClient', 'desc'));

    const unsub = onSnapshot(
      q,
      (snapshot) => {
        const items = snapshot.docs.map((doc) => {
          const data = doc.data();
          return {
            id: doc.id,
            localUri: data.localUri || '',
            source: data.source || 'unknown',
            createdAt: data.createdAt?.toDate?.()?.toISOString?.() || null,
            createdAtClient: data.createdAtClient || 0,
            downloadURL: data.downloadURL || '',
            storagePath: data.storagePath || '',
          };
        });
        setTakes(items);
        setTakesLoading(false);
      },
      (err) => {
        setTakesLoading(false);
        Alert.alert('Firestore error', err.message || String(err));
      }
    );

    return unsub;
  }, [user?.uid]);

  // ---------- AUTH ----------
  const handleAuthSubmit = async () => {
    if (!email.trim() || !password.trim()) {
      Alert.alert('Missing fields', 'Please enter email and password.');
      return;
    }

    if (password.length < 6) {
      Alert.alert('Password too short', 'Use at least 6 characters.');
      return;
    }

    setAuthBusy(true);
    try {
      if (authMode === 'signup') {
        await createUserWithEmailAndPassword(auth, email.trim(), password);
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      }

      setPassword('');
      setScreen('home');
    } catch (err) {
      Alert.alert('Auth error', err?.message || String(err));
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
      setScreen('home');
    } catch (err) {
      Alert.alert('Sign out error', err?.message || String(err));
    }
  };

  // ---------- SAVE TAKE METADATA ----------
  const saveTakeDoc = async ({
    localUri,
    source,
    downloadURL = '',
    storagePath = '',
  }) => {
    if (!user?.uid) {
      Alert.alert('Sign in required', 'Please sign in to save takes.');
      return;
    }

    await addDoc(collection(db, 'users', user.uid, 'takes'), {
      localUri: localUri || '',
      source: source || 'unknown',
      downloadURL,
      storagePath,
      createdAt: serverTimestamp(),
      createdAtClient: Date.now(),
    });
  };

  // ---------- CAMERA FLOW ----------
  const openCamera = async () => {
    if (!user?.uid) {
      Alert.alert('Sign in first', 'Create an account or sign in before recording.');
      return;
    }

    // Web fallback mode (Codespaces)
    if (Platform.OS === 'web') {
      setScreen('camera');
      return;
    }

    if (!permission) {
      Alert.alert('Please wait', 'Checking camera permission...');
      return;
    }

    if (!permission.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        Alert.alert(
          'Camera access needed',
          'Please allow camera permission so you can record a take.'
        );
        return;
      }
    }

    setScreen('camera');
  };

  const startRecording = async () => {
    // Web demo fallback (no real video file in Codespaces web)
    if (Platform.OS === 'web') {
      setIsRecording(true);
      setTimeout(async () => {
        try {
          const fakeUri = `web-demo://take-${Date.now()}`;
          await saveTakeDoc({
            localUri: fakeUri,
            source: 'web-demo',
            downloadURL: '',
            storagePath: '',
          });
          Alert.alert('Take saved', 'Web demo take saved to Firestore.');
        } catch (err) {
          Alert.alert('Save error', err?.message || String(err));
        } finally {
          setIsRecording(false);
          setScreen('home');
        }
      }, 700);
      return;
    }

    // Native path: record -> upload -> save doc
    try {
      if (!cameraRef.current) {
        Alert.alert('Camera not ready', 'Please wait a second and try again.');
        return;
      }

      setIsRecording(true);

      const video = await cameraRef.current.recordAsync({ maxDuration: 30 });

      if (!video?.uri) {
        Alert.alert('No video captured', 'Please try recording again.');
        return;
      }

      Alert.alert('Uploading...', 'Please wait while your video uploads.');

      const { storagePath, downloadURL } = await uploadVideoForUser({
        userId: user.uid,
        localUri: video.uri,
      });

      await saveTakeDoc({
        localUri: video.uri,
        source: 'camera',
        downloadURL,
        storagePath,
      });

      Alert.alert('Take saved', 'Video uploaded and saved to Firestore.');
      setScreen('home');
    } catch (error) {
      Alert.alert('Recording/upload error', String(error?.message || error));
    } finally {
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    if (Platform.OS === 'web') return;

    try {
      if (cameraRef.current && isRecording) {
        cameraRef.current.stopRecording();
      }
    } catch (error) {
      Alert.alert('Stop error', String(error?.message || error));
    }
  };

  const formatDate = (iso) => {
    if (!iso) return 'Saving...';
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  const takeCountLabel = useMemo(() => {
    if (takes.length === 0) return 'No takes yet';
    if (takes.length === 1) return '1 take saved';
    return `${takes.length} takes saved`;
  }, [takes.length]);

  // ---------- LOADING ----------
  if (authLoading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="light" />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#FFFFFF" />
          <Text style={styles.infoText}>Loading account...</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ---------- AUTH SCREEN ----------
  if (!user) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="light" />
        <View style={styles.container}>
          <Text style={styles.title}>OneTake</Text>
          <Text style={styles.subtitle}>
            {authMode === 'signup'
              ? 'Create your account to start saving takes.'
              : 'Sign in to access your takes.'}
          </Text>

          <TextInput
            style={styles.input}
            placeholder="Email"
            placeholderTextColor="#94A3B8"
            autoCapitalize="none"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
          />

          <TextInput
            style={styles.input}
            placeholder="Password (min 6 chars)"
            placeholderTextColor="#94A3B8"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />

          <TouchableOpacity style={styles.primaryButton} onPress={handleAuthSubmit} disabled={authBusy}>
            <Text style={styles.primaryButtonText}>
              {authBusy ? 'Please wait...' : authMode === 'signup' ? 'Create Account' : 'Sign In'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => setAuthMode((m) => (m === 'signin' ? 'signup' : 'signin'))}
          >
            <Text style={styles.secondaryButtonText}>
              {authMode === 'signin'
                ? 'Need an account? Sign up'
                : 'Already have an account? Sign in'}
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ---------- CAMERA SCREEN ----------
  if (screen === 'camera') {
    const isWeb = Platform.OS === 'web';

    return (
      <View style={styles.cameraScreen}>
        <StatusBar style="light" />

        {isWeb ? (
          <View style={styles.webCameraPlaceholder}>
            <Text style={styles.webCameraTitle}>Web Demo Mode</Text>
            <Text style={styles.webCameraText}>
              In web/Codespaces, recording creates a demo take in Firestore.
            </Text>
            <Text style={styles.webCameraText}>
              Real file upload works on mobile device recording.
            </Text>
          </View>
        ) : (
          <CameraView ref={cameraRef} style={styles.cameraPreview} facing="back" mode="video" />
        )}

        <View style={styles.cameraOverlay}>
          <Text style={styles.cameraTitle}>OneTake Camera</Text>
          <Text style={styles.cameraSubtitle}>
            {isWeb
              ? 'Start = save demo take'
              : isRecording
              ? 'Recording... tap Stop when done'
              : 'Tap Start to record your one take'}
          </Text>

          {!isRecording ? (
            <TouchableOpacity style={styles.primaryButton} onPress={startRecording}>
              <Text style={styles.primaryButtonText}>
                {isWeb ? 'Start Recording (Web Demo)' : 'Start Recording'}
              </Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={styles.stopButton} onPress={stopRecording}>
              <Text style={styles.primaryButtonText}>
                {isWeb ? 'Saving Demo Take...' : 'Stop Recording'}
              </Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity style={styles.secondaryButton} onPress={() => setScreen('home')}>
            <Text style={styles.secondaryButtonText}>Back to Home</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ---------- TAKES SCREEN ----------
  if (screen === 'takes') {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="light" />
        <View style={styles.container}>
          <Text style={styles.title}>My Takes</Text>
          <Text style={styles.subtitle}>{takeCountLabel}</Text>

          {takesLoading ? (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyText}>Loading takes...</Text>
            </View>
          ) : takes.length === 0 ? (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyText}>No takes yet. Record your first one!</Text>
            </View>
          ) : (
            <FlatList
              data={takes}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.listContent}
              renderItem={({ item, index }) => (
                <View style={styles.takeCard}>
                  <Text style={styles.takeTitle}>Take #{takes.length - index}</Text>
                  <Text style={styles.takeMeta}>{formatDate(item.createdAt)}</Text>
                  <Text style={styles.takeMeta}>Source: {item.source}</Text>
                  <Text style={styles.takeUri} numberOfLines={1}>
                    localUri: {item.localUri || '(none)'}
                  </Text>
                  <Text style={styles.takeUri} numberOfLines={1}>
                    downloadURL: {item.downloadURL ? 'available ✅' : 'not available'}
                  </Text>
                </View>
              )}
            />
          )}

          <TouchableOpacity style={styles.secondaryButton} onPress={() => setScreen('home')}>
            <Text style={styles.secondaryButtonText}>Back to Home</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ---------- HOME ----------
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <View style={styles.container}>
        <Text style={styles.title}>OneTake</Text>
        <Text style={styles.subtitle}>Signed in as: {user.email}</Text>

        <TouchableOpacity style={styles.primaryButton} onPress={openCamera}>
          <Text style={styles.primaryButtonText}>Record One Take</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.secondaryButton} onPress={() => setScreen('takes')}>
          <Text style={styles.secondaryButtonText}>View My Takes</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut}>
          <Text style={styles.signOutText}>Sign Out</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0B1020' },
  container: { flex: 1, paddingHorizontal: 24, justifyContent: 'center' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20 },

  title: {
    fontSize: 42,
    fontWeight: '800',
    color: '#FFFFFF',
    marginBottom: 12,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    lineHeight: 24,
    color: '#C7D2FE',
    textAlign: 'center',
    marginBottom: 24,
  },

  input: {
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#334155',
    color: '#FFFFFF',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
  },

  primaryButton: {
    backgroundColor: '#4F46E5',
    paddingVertical: 16,
    borderRadius: 14,
    marginBottom: 14,
    alignItems: 'center',
  },
  stopButton: {
    backgroundColor: '#DC2626',
    paddingVertical: 16,
    borderRadius: 14,
    marginBottom: 14,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#FFFFFF', fontSize: 17, fontWeight: '700' },

  secondaryButton: {
    borderWidth: 1,
    borderColor: '#64748B',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    marginBottom: 10,
  },
  secondaryButtonText: { color: '#E2E8F0', fontSize: 16, fontWeight: '600' },

  signOutButton: {
    marginTop: 6,
    alignItems: 'center',
    paddingVertical: 12,
  },
  signOutText: {
    color: '#FCA5A5',
    fontSize: 14,
    fontWeight: '700',
  },

  cameraScreen: { flex: 1, backgroundColor: '#000' },
  cameraPreview: { flex: 1 },

  webCameraPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    backgroundColor: '#020617',
  },
  webCameraTitle: {
    color: '#FFFFFF',
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  webCameraText: {
    color: '#C7D2FE',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 6,
  },

  cameraOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: 16,
    backgroundColor: 'rgba(11,16,32,0.85)',
  },
  cameraTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 6,
  },
  cameraSubtitle: {
    color: '#C7D2FE',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 14,
  },

  listContent: { paddingBottom: 16 },
  takeCard: {
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    backgroundColor: '#111827',
  },
  takeTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '700', marginBottom: 4 },
  takeMeta: { color: '#94A3B8', fontSize: 12, marginBottom: 6 },
  takeUri: { color: '#CBD5E1', fontSize: 12, marginBottom: 4 },

  emptyCard: {
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    backgroundColor: '#111827',
  },
  emptyText: { color: '#CBD5E1', textAlign: 'center' },

  infoText: { marginTop: 12, color: '#C7D2FE', textAlign: 'center' },
});