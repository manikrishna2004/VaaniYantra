import { ImageResponse } from 'next/og';
import { INDIAN_LANGUAGE_COUNT } from '@/lib/constants';

// Branded 1200×630 Open Graph card. Shown when the site is shared on
// WhatsApp/LinkedIn/X/Slack etc. Rendered at request time: @vercel/og fails at
// build-time prerender when the project path contains a space (Windows dev).
export const dynamic = 'force-dynamic';

export const alt = 'VaaniYantra — an AI automations agency. We build the automation, and we run it.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// Static pseudo-waveform heights (coral bars along the bottom).
const BARS = Array.from({ length: 48 }).map((_, i) => 16 + Math.round(64 * Math.abs(Math.sin(i * 0.9))));

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '72px 80px 56px',
          background: 'linear-gradient(135deg, #ffffff 55%, #e6f2f1 100%)',
          color: '#101828',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 9999,
              background: '#4b3fce',
              boxShadow: '0 0 40px 8px rgba(75,63,206,0.28)',
            }}
          />
          <div style={{ fontSize: 40, fontWeight: 700 }}>VaaniYantra</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div style={{ display: 'flex', flexDirection: 'column', fontSize: 76, fontWeight: 700, lineHeight: 1.08 }}>
            <span>We build the automation.</span>
            <span style={{ color: '#4b3fce' }}>We run it too.</span>
          </div>
          <div style={{ fontSize: 30, color: '#5d6b7d' }}>
            {/* Single child on purpose: Satori demands an explicit display on any
                div with more than one child, and interpolating mid-sentence splits
                this into three text nodes. Build the string instead. */}
            {`AI voice agents & automations · six industries · ${INDIAN_LANGUAGE_COUNT} Indian languages · your cloud or ours`}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 80 }}>
          {BARS.map((h, i) => (
            <div
              key={i}
              style={{
                width: 10,
                height: h,
                borderRadius: 9999,
                background: i % 5 === 0 ? '#4b3fce' : 'rgba(75,63,206,0.35)',
              }}
            />
          ))}
        </div>
      </div>
    ),
    { ...size },
  );
}
