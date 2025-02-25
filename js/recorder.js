let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;

const preferredFormats = [
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=h264,opus',
    'video/webm',
    'video/mp4;codecs=h264,aac',
    'video/mp4'
];

async function getSupportedMimeType() {
    for (const format of preferredFormats) {
        if (MediaRecorder.isTypeSupported(format)) {
            console.log('Using format:', format);
            return format;
        }
    }
    console.warn('No preferred format supported, using browser default');
    return '';
}

function createMediaRecorder(stream, mimeType) {
    try {
        const options = mimeType ? { 
            mimeType,
            videoBitsPerSecond: 2500000, // 2.5 Mbps for better quality
            audioBitsPerSecond: 128000   // 128 kbps for audio
        } : undefined;
        return new MediaRecorder(stream, options);
    } catch (e) {
        console.warn('Failed to create MediaRecorder with mimeType:', mimeType, e);
        return new MediaRecorder(stream);
    }
}

// Make startRecording available in the global scope for recorder-ui.js
window.startRecording = async function(options = {}) {
    try {
        console.log('Starting recording with options:', options);
        
        // Reset state
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        mediaRecorder = null;
        recordedChunks = [];
        isRecording = false;

        // Request screen capture with system audio
        console.log('Requesting screen capture...');
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                cursor: options.showCursor ? 'always' : 'never',
                displaySurface: 'monitor'
            },
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                sampleRate: 44100,
                channelCount: 2
            }
        });

        // Set up screen track ended handler
        displayStream.getVideoTracks()[0].onended = () => {
            console.log('Screen sharing stopped by user');
            stopRecording();
        };

        let audioContext;
        let audioDestination;
        let audioTracks = [];

        // Try to get microphone audio if requested
        if (options.recordMicrophone) {
            try {
                console.log('Requesting microphone...');
                const micStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        sampleRate: 44100,
                        channelCount: 2
                    }
                });
                console.log('Microphone access granted');

                // Create audio context for mixing
                audioContext = new AudioContext();
                audioDestination = audioContext.createMediaStreamDestination();

                // Add system audio if present
                const systemAudioTrack = displayStream.getAudioTracks()[0];
                if (systemAudioTrack) {
                    const systemSource = audioContext.createMediaStreamSource(new MediaStream([systemAudioTrack]));
                    systemSource.connect(audioDestination);
                    console.log('Added system audio to mix');
                }

                // Add microphone audio
                const micSource = audioContext.createMediaStreamSource(micStream);
                micSource.connect(audioDestination);
                console.log('Added microphone audio to mix');

                // Store the mixed audio track
                audioTracks = audioDestination.stream.getAudioTracks();
                console.log('Created mixed audio track');

            } catch (error) {
                console.warn('Could not get microphone:', error.name);
                // Continue with system audio only
                audioTracks = displayStream.getAudioTracks();
            }
        } else {
            // Use system audio only
            audioTracks = displayStream.getAudioTracks();
        }

        // Combine all tracks
        const videoTrack = displayStream.getVideoTracks()[0];
        const combinedStream = new MediaStream([
            videoTrack,
            ...audioTracks
        ]);

        console.log('Streams combined:', {
            video: combinedStream.getVideoTracks().length > 0,
            audio: combinedStream.getAudioTracks().length > 0,
            audioTracks: audioTracks.length
        });

        // Get supported format
        const mimeType = await getSupportedMimeType();
        
        // Create MediaRecorder
        mediaRecorder = createMediaRecorder(combinedStream, mimeType);
        console.log('MediaRecorder created:', {
            mimeType: mediaRecorder.mimeType,
            state: mediaRecorder.state
        });

        // Handle data
        mediaRecorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
                recordedChunks.push(event.data);
                console.log('Chunk recorded:', {
                    size: event.data.size,
                    type: event.data.type,
                    chunks: recordedChunks.length
                });
            }
        };

        // Handle recording stopped
        mediaRecorder.onstop = async () => {
            isRecording = false;
            console.log('Recording stopped');

            // Stop all tracks
            combinedStream.getTracks().forEach(track => {
                track.stop();
            });

            // Clean up audio context if it exists
            if (audioContext) {
                await audioContext.close();
            }

            if (recordedChunks.length === 0) {
                console.error('No data recorded');
                alert('No video data was recorded. Please try again.');
                return;
            }

            try {
                // Create a single blob from all chunks
                const finalBlob = new Blob(recordedChunks, { 
                    type: mediaRecorder.mimeType || 'video/webm' 
                });

                console.log('Processing recording...', {
                    size: finalBlob.size,
                    type: finalBlob.type,
                    chunks: recordedChunks.length
                });

                // Convert blob to array buffer for transfer
                const arrayBuffer = await finalBlob.arrayBuffer();
                const uint8Array = new Uint8Array(arrayBuffer);
                const arrayData = Array.from(uint8Array);

                console.log('Sending recording...', {
                    length: arrayData.length,
                    type: finalBlob.type
                });

                const response = await chrome.runtime.sendMessage({
                    action: 'STORE_RECORDED_BLOB',
                    chunks: [arrayData],
                    type: finalBlob.type
                });

                if (response.success) {
                    console.log('Recording saved');
                    window.location.href = chrome.runtime.getURL('preview.html');
                } else {
                    throw new Error(response.error || 'Failed to save recording');
                }
            } catch (error) {
                console.error('Save failed:', error);
                alert('Failed to save recording: ' + error.message);
            }
        };

        // Handle errors
        mediaRecorder.onerror = (error) => {
            console.error('MediaRecorder error:', error);
            alert('Recording error: ' + error.message);
            stopRecording();
        };

        // Start recording with smaller chunks for better handling
        mediaRecorder.start(500); // 500ms chunks
        isRecording = true;
        console.log('Recording started');

    } catch (error) {
        console.error('Start recording failed:', error);
        alert('Failed to start recording: ' + (error.message || error.name));
        
        // Cleanup
        if (mediaRecorder) {
            try {
                mediaRecorder.stop();
            } catch (e) {
                // Ignore stop errors
            }
            mediaRecorder = null;
        }
        isRecording = false;
        recordedChunks = [];
        throw error;
    }
};

// Make stopRecording available in the global scope for recorder-ui.js
window.stopRecording = function() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        console.log('Stopping recording...');
        try {
            mediaRecorder.stop();
        } catch (error) {
            console.error('Error stopping recording:', error);
        }
    }
    isRecording = false;
};

// Listen for messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('Recorder received:', request.action, request.options);

    switch (request.action) {
        case 'START_RECORDING':
            startRecording(request.options)
                .then(() => {
                    console.log('Recording started successfully');
                    sendResponse({ success: true });
                })
                .catch(error => {
                    console.error('Start recording failed:', error);
                    sendResponse({ 
                        success: false, 
                        error: error.message || error.name 
                    });
                });
            return true;

        case 'STOP_RECORDING':
            stopRecording();
            sendResponse({ success: true });
            return true;

        default:
            console.warn('Unknown action:', request.action);
            sendResponse({ success: false, error: 'Unknown action' });
            return true;
    }
});