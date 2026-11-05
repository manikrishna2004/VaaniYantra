import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { requireWorkspace } from '@/lib/auth/context';
import { getGeminiApiKey } from '@/lib/platform';
import { GEMINI_VOICES } from '@/lib/constants';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// #2: synthesize a short demo clip for a Gemini Live voice so customers can hear
// it before assigning it to an agent. Uses the Gemini TTS model and returns WAV.
// Clips are cached in-process (they never change) to avoid repeat TTS spend, and
// failures (e.g. free-tier 429) return 503 so the UI can fall back gracefully.

const TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
const cache = new Map<string, Buffer>();

// Wrap raw little-endian PCM16 mono in a minimal WAV container for <audio>.
function pcmToWav(pcm: Buffer, sampleRate = 24000): Buffer {
  const header = Buffer.alloc(44);
  const dataLen = pcm.length;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(1, 22); // channels
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate (mono, 16-bit)
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, pcm]);
}

export async function GET(req: Request) {
  const { error } = await requireWorkspace().then(
    () => ({ error: null as null }),
    () => ({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }),
  );
  if (error) return error;

  const params = new URL(req.url).searchParams;
  const voiceId = params.get('voice') || '';
  const voice = GEMINI_VOICES.find((v) => v.id === voiceId);
  if (!voice) return NextResponse.json({ error: 'Unknown voice' }, { status: 400 });

  // Sample phrase in the selected language so the test reflects a real call.
  const langCode = (params.get('lang') || 'en-IN').toLowerCase().split('-')[0];
  const SAMPLES: Record<string, string> = {
    en: `Hi, I'm ${voice.label}. This is how I'll sound on your calls — happy to help book your appointment.`,
    hi: 'नमस्ते! मैं आपकी कॉल पर ऐसे ही बात करूँगा। आपका अपॉइंटमेंट बुक करने में मुझे खुशी होगी।',
    ta: 'வணக்கம்! உங்கள் அழைப்பில் நான் இப்படித்தான் பேசுவேன். உங்கள் சந்திப்பை பதிவு செய்ய மகிழ்ச்சி.',
    te: 'నమస్తే! మీ కాల్‌లో నేను ఇలాగే మాట్లాడతాను. మీ అపాయింట్‌మెంట్ బుక్ చేయడం ఆనందంగా ఉంది.',
    bn: 'নমস্কার! আপনার কলে আমি এভাবেই কথা বলব। আপনার অ্যাপয়েন্টমেন্ট বুক করতে পেরে খুশি।',
    mr: 'नमस्कार! तुमच्या कॉलवर मी असाच बोलेन. तुमची अपॉइंटमेंट बुक करायला आनंद होईल.',
    gu: 'નમસ્તે! તમારા કૉલ પર હું આ રીતે વાત કરીશ. તમારી એપોઇન્ટમેન્ટ બુક કરવામાં આનંદ થશે.',
    kn: 'ನಮಸ್ಕಾರ! ನಿಮ್ಮ ಕರೆಯಲ್ಲಿ ನಾನು ಹೀಗೆ ಮಾತನಾಡುತ್ತೇನೆ. ನಿಮ್ಮ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ಬುಕ್ ಮಾಡಲು ಸಂತೋಷ.',
    ml: 'നമസ്കാരം! നിങ്ങളുടെ കോളിൽ ഞാൻ ഇങ്ങനെയാണ് സംസാരിക്കുക. നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റ് ബുക്ക് ചെയ്യാൻ സന്തോഷം.',
    pa: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ! ਤੁਹਾਡੀ ਕਾਲ ਉੱਤੇ ਮੈਂ ਇੰਜ ਗੱਲ ਕਰਾਂਗਾ। ਤੁਹਾਡੀ ਮੁਲਾਕਾਤ ਬੁੱਕ ਕਰਨ ਵਿੱਚ ਖੁਸ਼ੀ ਹੋਵੇਗੀ।',
  };
  const text = SAMPLES[langCode] || SAMPLES.en;
  const cacheKey = `${voice.id}:${langCode}`;

  const cached = cache.get(cacheKey);
  if (cached) {
    return new NextResponse(cached as any, {
      headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'public, max-age=86400' },
    });
  }

  const apiKey = await getGeminiApiKey().catch(() => undefined);
  if (!apiKey) return NextResponse.json({ error: 'Voice preview not available' }, { status: 503 });

  try {
    const ai = new GoogleGenAI({ apiKey });
    const res = await ai.models.generateContent({
      model: TTS_MODEL,
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice.id } } },
      } as any,
    });
    const b64 = res.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!b64) return NextResponse.json({ error: 'No audio returned' }, { status: 503 });
    const wav = pcmToWav(Buffer.from(b64, 'base64'));
    cache.set(cacheKey, wav);
    return new NextResponse(wav as any, {
      headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'public, max-age=86400' },
    });
  } catch (err: any) {
    const status = String(err?.message || '').includes('429') ? 429 : 503;
    return NextResponse.json({ error: 'Preview unavailable (try a test call)' }, { status });
  }
}
