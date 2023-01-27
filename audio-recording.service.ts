import {Injectable} from '@angular/core';


const numChannels = 2;
const constraints = {
  audio: true
};

@Injectable({
  providedIn: 'root'
})
export class AudioRecordingService {

  timer: {sec: number, timerId?: NodeJS.Timer} = {sec: 0};
  failedToGetUserMedia = false;

  private recBuffers: Float32Array[][] = [];
  private recLength: number = 0;
  private listening: boolean = false;

  private stream: MediaStream;
  private audioSource: MediaStreamAudioSourceNode;
  private context: BaseAudioContext;
  private recorder: AudioWorkletNode;

  constructor() {
    this.initBuffers();
  }

  /**
   * Start record
   */
  start(): void {
    if (this.listening) return;

    this.listening = true;

    navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
      this.stream = stream;
      this.startRecord(stream)
        .then(() => {
          this.startTimer();
        })
    }).catch((err) => {
      alert('Unable to access audio.\n\n' + err);
      console.log('The following error occurred: ' + err);
    });
  }

  /**
   * Stop record, disconnect streaming
   */
  stop() {
    this.listening = false;
    
    clearInterval(this.timer.timerId);
    this.timer.timerId = undefined;
    this.timer.sec = 0;

    this.disconnectStreaming();
  }

  /**
   * Clear last recorded data
   */
  clear() {
    this.recLength = 0;
    this.recBuffers = [];
    this.initBuffers();
  }

  /**
   * Convert recBuffers data to WAV file
   * @param name
   */
  exportWAV(name?: string): File {
    let buffers: Float32Array[] = [];
    for (var i = 0; i < numChannels; i++) {
      buffers.push(mergeBuffers(this.recBuffers[i], this.recLength));
    }

    let interleaved = numChannels == 2 ? interleave(buffers[0], buffers[1]) : buffers[0];
    let sampleRate = this.audioSource.context.sampleRate;
    let dataView = encodeWAV(interleaved, sampleRate);
    let blob = new Blob([dataView], {'type': 'audio/wav; codecs=MS_PCM'});

    return new File([blob], name || Math.floor((new Date()).getTime() / 1000) + '.wav');
  }

  /**
   * Init and start AudioWorklet recording, start timer
   * @param stream
   * @private
   */
  private async startRecord(stream: MediaStream) {
    let audioContext = new AudioContext();
    this.audioSource = audioContext.createMediaStreamSource(stream);
    this.context = this.audioSource.context;

    await this.context.audioWorklet.addModule("processor.js");  //should be a separate file, for some reason can be 'seen' only from assets folder in Angular project
    this.recorder = new AudioWorkletNode(this.context, "recorder.worklet");

    this.audioSource.connect(this.recorder);
    this.recorder.connect(this.context.destination);

    this.recorder.port.onmessage = (m: { data:  Float32Array }) => {
      if (!this.listening) return;

      for (let i = 0; i < numChannels; i++) {
        this.recBuffers[i].push(m.data);
      }

      this.recLength += this.recBuffers[0][0].length;
      return true;
    }
  }

  /**
   * Start timer
   * @private
   */
  private startTimer() {
    this.timer.timerId = setInterval(() => this.timer.sec++, 1000);
  }

  /**
   * Init recBuffers channels arrays
   * @private
   */
  private initBuffers() {
    for (var channel = 0; channel < numChannels; channel++) {
      this.recBuffers[channel] = [];
    }
  }

  /**
   * Disconnect AudioWorklet and UserMediaStream tracks
   * @private
   */
  private disconnectStreaming() {
    this.audioSource.disconnect();
    this.recorder.disconnect();
    this.stream.getTracks().forEach(track => {
      track.stop();
    });
  }


}

/**
 * Merge data buffers to one Float32Array
 * @param buffers
 * @param len
 */
function mergeBuffers(buffers: Float32Array[], len: number): Float32Array {
  let result = new Float32Array(len);
  let offset = 0;
  for (var i = 0; i < buffers.length; i++) {
    result.set(buffers[i], offset);
    offset += buffers[i].length;
  }
  return result;
}

/**
 * Interleave two Float32Arrays into one
 * @param inputL
 * @param inputR
 */
function interleave(inputL: Float32Array, inputR: Float32Array): Float32Array {
  let len = inputL.length + inputR.length;
  let result = new Float32Array(len);

  let index = 0;
  let inputIndex = 0;

  while (index < len) {
    result[index++] = inputL[inputIndex];
    result[index++] = inputR[inputIndex];
    inputIndex++;
  }

  return result;
}

/**
 * Encode Float32Array buffer into WAV data view
 * @param samples
 * @param sampleRate
 */
function encodeWAV(samples: Float32Array, sampleRate: number): DataView {
  let buffer = new ArrayBuffer(44 + samples.length * 2);
  let view = new DataView(buffer);

  /* RIFF identifier */
  writeString(view, 0, 'RIFF');
  /* file length */
  view.setUint32(4, 36 + samples.length * 2, true);
  /* RIFF type */
  writeString(view, 8, 'WAVE');
  /* format chunk identifier */
  writeString(view, 12, 'fmt ');
  /* format chunk length */
  view.setUint32(16, 16, true);
  /* sample format (raw) */
  view.setUint16(20, 1, true);
  /* channel count */
  view.setUint16(22, numChannels, true);
  /* sample rate */
  view.setUint32(24, sampleRate, true);
  /* byte rate (sample rate * block align) */
  view.setUint32(28, sampleRate * 4, true);
  /* block align (channel count * bytes per sample) */
  view.setUint16(32, numChannels * 2, true);
  /* bits per sample */
  view.setUint16(34, 16, true);
  /* data chunk identifier */
  writeString(view, 36, 'data');
  /* data chunk length */
  view.setUint32(40, samples.length * 2, true);

  floatTo16BitPCM(view, 44, samples);

  return view;
}

/**
 * Convert Float32Array to 16Bit PCM
 * @param output
 * @param offset
 * @param input
 */
function floatTo16BitPCM(output: DataView, offset: number, input: Float32Array) {
  for (var i = 0; i < input.length; i++, offset += 2) {
    var s = Math.max(-1, Math.min(1, input[i]));
    output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
}

/**
 * Write string to DataView
 * @param view
 * @param offset
 * @param string
 */
function writeString(view: DataView, offset: number, string: string) {
  for (var i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}
