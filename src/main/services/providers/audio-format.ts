/** Keep multipart metadata consistent with the actual stored bytes. */
export function audioFormat(bytes: Uint8Array): {mime:string;extension:string} {
  const magic=String.fromCharCode(...bytes.slice(0,4))
  return magic==='RIFF'?{mime:'audio/wav',extension:'wav'}:magic==='OggS'?{mime:'audio/ogg',extension:'ogg'}:{mime:'audio/webm',extension:'webm'}
}
