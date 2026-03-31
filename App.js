import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import './src/lib/firebase';

export default function App() {
  const [screen, setScreen] = useState('home'); // home | camera | takes
  const [isRecording, setIsRecording] = useState(false);
  const [takes, setTakes] = useState([]);
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef(null);

  const addTake = (uri, source = 'camera') => {
    const newTake = {
      id: `${Date.now()}`,
      uri,
      source,
      createdAt: new Date().toISOString(),
    };
    setTakes((prev) => [newTake, ...prev]);
  };

  const openCamera = async () => {
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
    if (Platform.OS === 'web') {
      setIsRecording(true);
      setTimeout(() => {
        addTake(`web-demo://take-${Date.now()}`, 'web-demo');
        setIsRecording(false);
        Alert.alert('Demo take saved', 'Web demo mode saved a sample take.');
        setScreen('home');
      }, 700);
      return;
    }

    try {
      if (!cameraRef.current) {
        Alert.alert('Camera not ready', 'Please wait a second and try again.');
        return;
      }

      setIsRecording(true);

      const video = await cameraRef.current.recordAsync({
        maxDuration: 30,
      });

      if (video?.uri) {
        addTake(video.uri, 'camera');
        Alert.alert('Take saved', 'Your video was saved to My Takes.');
      } else {
        Alert.alert('No video captured', 'Please try recording again.');
      }

      setScreen('home');
    } catch (error) {
      Alert.alert('Recording error', String(error?.message || error));
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
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  const takeCountLabel =
    takes.length === 0 ? 'No takes yet' : takes.length === 1 ? '1 take saved' : `${takes.length} takes saved`;

  if (!permission && Platform.OS !== 'web') {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="light" />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#FFFFFF" />
          <Text style={styles.infoText}>Checking camera permission...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (screen === 'camera') {
    const isWeb = Platform.OS === 'web';

    return (
      <View style={styles.cameraScreen}>
        <StatusBar style="light" />
        {isWeb ? (
          <View style={styles.webCameraPlaceholder}>
            <Text style={styles.webCameraTitle}>Web Demo Mode</Text>
            <Text style={styles.webCameraText}>
              Real camera recording is limited in Codespaces web preview.
            </Text>
            <Text style={styles.webCameraText}>
              We’ll enable real phone camera testing later on local Expo Go.
            </Text>
          </View>
        ) : (
          <CameraView ref={cameraRef} style={styles.cameraPreview} facing="back" mode="video" />
        )}

        <View style={styles.cameraOverlay}>
          <Text style={styles.cameraTitle}>OneTake Camera</Text>
          <Text style={styles.cameraSubtitle}>
            {isWeb
              ? 'Start Recording will create a demo take in web mode'
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

  if (screen === 'takes') {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="light" />
        <View style={styles.container}>
          <Text style={styles.title}>My Takes</Text>
          <Text style={styles.subtitle}>{takeCountLabel}</Text>

          {takes.length === 0 ? (
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
                  <Text style={styles.takeUri} numberOfLines={2}>
                    {item.uri}
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

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <View style={styles.container}>
        <Text style={styles.title}>OneTake</Text>
        <Text style={styles.subtitle}>
          Record one authentic take. No heavy edits. Just real moments.
        </Text>

        <TouchableOpacity style={styles.primaryButton} onPress={openCamera}>
          <Text style={styles.primaryButtonText}>Record One Take</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.secondaryButton} onPress={() => setScreen('takes')}>
          <Text style={styles.secondaryButtonText}>View My Takes</Text>
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
  },
  secondaryButtonText: { color: '#E2E8F0', fontSize: 16, fontWeight: '600' },

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
  takeUri: { color: '#CBD5E1', fontSize: 12 },

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