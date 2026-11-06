// Decodes every video frame of a file with AVFoundation, the decoder QuickTime uses, and prints how far
// it got as JSON. ffmpeg plays through streams that QuickTime freezes on, so ffmpeg can't answer
// "does this play on a Mac?". macOS only.
//
//   swift scripts/check-playback.swift <video>
//   {"frames":128,"decodedTo":4.47,"duration":4.5,"completed":true}
import AVFoundation
import Foundation

let asset = AVURLAsset(url: URL(fileURLWithPath: CommandLine.arguments[1]))
let loaded = DispatchSemaphore(value: 0)
var track: AVAssetTrack?
var duration = 0.0
Task {
    track = try? await asset.loadTracks(withMediaType: .video).first
    duration = (try? await asset.load(.duration).seconds) ?? 0
    loaded.signal()
}
loaded.wait()
guard let track, let reader = try? AVAssetReader(asset: asset) else {
    print(#"{"frames":0,"decodedTo":0,"duration":0,"completed":false,"error":"no video track"}"#)
    exit(1)
}
let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
reader.add(output)
reader.startReading()
var frames = 0
var decodedTo = 0.0
while let sample = output.copyNextSampleBuffer() {
    guard CMSampleBufferGetImageBuffer(sample) != nil else { continue }
    frames += 1
    decodedTo = CMSampleBufferGetPresentationTimeStamp(sample).seconds
}
let completed = reader.status == .completed
let error = (reader.error?.localizedDescription ?? "").replacingOccurrences(of: "\"", with: "'")
print(String(format: #"{"frames":%d,"decodedTo":%.2f,"duration":%.2f,"completed":%@%@}"#,
             frames, decodedTo, duration, completed ? "true" : "false", completed ? "" : #","error":"\#(error)""#))
exit(completed ? 0 : 1)
