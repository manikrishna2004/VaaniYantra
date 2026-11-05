import { describe, it, expect, vi, beforeEach } from 'vitest';

// The SSRF guard stands in front of every server-side fetch of a URL the
// customer supplies: webhook delivery, webhook "send test", and URL knowledge
// ingest. On this deployment (GCP) the sharpest target is the link-local
// metadata server at 169.254.169.254, which hands out service-account tokens to
// anything that can make an HTTP request from the VM.
//
// It had no test at all. These cover the address classifier directly and the
// resolve-then-check path, including the DNS-rebinding shape where a public
// hostname resolves to a private address.

const lookup = vi.hoisted(() => vi.fn());
vi.mock('dns/promises', () => ({ default: { lookup }, lookup }));

import { isPrivateIp, assertPublicUrl, SsrfError } from '@/lib/net/ssrf';

const resolvesTo = (...addresses: string[]) =>
  lookup.mockResolvedValueOnce(addresses.map((address) => ({ address, family: net(address) })));
const net = (ip: string) => (ip.includes(':') ? 6 : 4);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isPrivateIp', () => {
  it('rejects the cloud metadata address and the rest of link-local', () => {
    // The one that turns an SSRF into stolen credentials on this deployment.
    expect(isPrivateIp('169.254.169.254')).toBe(true);
    expect(isPrivateIp('169.254.0.1')).toBe(true);
  });

  it('rejects loopback, RFC1918, CGNAT and 0.0.0.0', () => {
    for (const ip of [
      '127.0.0.1',
      '127.9.9.9',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1',
      '100.127.255.255',
      '0.0.0.0',
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '34.138.86.231', '172.32.0.1', '172.15.0.1', '100.63.255.255']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it('gets the 172.16/12 boundaries right', () => {
    // 172.16-172.31 is private; 172.15 and 172.32 are not. Off-by-one here
    // either blocks legitimate customers or opens the private range.
    expect(isPrivateIp('172.15.255.255')).toBe(false);
    expect(isPrivateIp('172.16.0.0')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('172.32.0.0')).toBe(false);
  });

  it('handles IPv6 loopback, link-local and unique-local', () => {
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('fe80::1')).toBe(true);
    expect(isPrivateIp('fc00::1')).toBe(true);
    expect(isPrivateIp('fd12:3456::1')).toBe(true);
    expect(isPrivateIp('2606:4700:4700::1111')).toBe(false);
  });

  it('sees through IPv4-mapped IPv6, including for the metadata address', () => {
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:169.254.169.254')).toBe(true);
    expect(isPrivateIp('::ffff:8.8.8.8')).toBe(false);
  });

  it('treats anything it cannot parse as unsafe', () => {
    for (const junk of ['', 'not-an-ip', '999.999.999.999', '127.0.0.1.evil.com']) {
      expect(isPrivateIp(junk), junk).toBe(true);
    }
  });
});

describe('assertPublicUrl', () => {
  it('accepts a public https URL', async () => {
    resolvesTo('93.184.216.34');
    await expect(assertPublicUrl('https://example.com/hook')).resolves.toMatchObject({
      hostname: 'example.com',
    });
  });

  it('rejects a non-http scheme', async () => {
    for (const raw of ['file:///etc/passwd', 'ftp://example.com', 'gopher://example.com']) {
      await expect(assertPublicUrl(raw)).rejects.toBeInstanceOf(SsrfError);
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects garbage that is not a URL', async () => {
    await expect(assertPublicUrl('just some text')).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects localhost by name without needing DNS', async () => {
    for (const raw of ['http://localhost/x', 'http://LOCALHOST/x', 'http://api.localhost/x']) {
      await expect(assertPublicUrl(raw), raw).rejects.toBeInstanceOf(SsrfError);
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects the GCP metadata hostname by name', async () => {
    await expect(assertPublicUrl('http://metadata.google.internal/computeMetadata/v1/')).rejects.toBeInstanceOf(
      SsrfError,
    );
  });

  it('rejects a literal private IP without a DNS round trip', async () => {
    for (const raw of [
      'http://127.0.0.1:8080/x',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/x',
      'http://[::1]/x',
    ]) {
      await expect(assertPublicUrl(raw), raw).rejects.toBeInstanceOf(SsrfError);
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects a public hostname that resolves to a private address', async () => {
    // The rebinding shape: the name looks fine, the answer does not.
    resolvesTo('169.254.169.254');
    await expect(assertPublicUrl('https://totally-normal.example.com/x')).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects when ANY resolved address is private, not just the first', async () => {
    // A host with mixed records must not be let through on the strength of one
    // good answer — the fetch could use either.
    resolvesTo('93.184.216.34', '10.1.2.3');
    await expect(assertPublicUrl('https://mixed.example.com/x')).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects a host that resolves to nothing', async () => {
    lookup.mockResolvedValueOnce([]);
    await expect(assertPublicUrl('https://empty.example.com/x')).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects a host that will not resolve at all', async () => {
    lookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
    await expect(assertPublicUrl('https://nope.example.com/x')).rejects.toBeInstanceOf(SsrfError);
  });

  it('explains itself in language a customer can act on', async () => {
    resolvesTo('10.0.0.1');
    await expect(assertPublicUrl('https://internal.example.com/x')).rejects.toThrow(/non-public address/i);
  });
});
