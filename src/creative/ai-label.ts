import { readFileSync, writeFileSync } from "node:fs";

/**
 * The AI-content mark on images that show AI-generated material (the demo
 * cast's invented people and photos): IPTC's Digital Source Type in an XMP
 * packet — the industry-standard signal Meta reads for its "AI info" label
 * (alongside C2PA). TikTok gets its own flag on the post (is_aigc). Videos
 * aren't marked here (no standard field in MP4 that Meta documents); their
 * TikTok flag and the post card say it instead.
 */

export const AI_SOURCE_TYPE = "http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia";

const XMP_NS = "http://ns.adobe.com/xap/1.0/\0";

/** Pure. The XMP packet. */
export function aiXmp(): string {
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" Iptc4xmpExt:DigitalSourceType="${AI_SOURCE_TYPE}"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
}

/** Pure. A JPEG with the XMP AI mark as an APP1 segment right after SOI (unchanged when not a JPEG or already marked). */
export function withAiMark(jpeg: Uint8Array): Uint8Array {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
  if (Buffer.from(jpeg.subarray(0, 4096)).includes(AI_SOURCE_TYPE)) return jpeg;
  const payload = Buffer.concat([Buffer.from(XMP_NS, "binary"), Buffer.from(aiXmp(), "utf-8")]);
  const seg = Buffer.alloc(4);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  seg.writeUInt16BE(payload.length + 2, 2);
  return new Uint8Array(Buffer.concat([Buffer.from(jpeg.subarray(0, 2)), seg, payload, Buffer.from(jpeg.subarray(2))]));
}

/** Marks a JPEG file in place. */
export function markAiJpeg(file: string): void {
  if (!/\.jpe?g$/i.test(file)) return;
  writeFileSync(file, withAiMark(new Uint8Array(readFileSync(file))));
}
