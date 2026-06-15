import { describe, it, expect } from "vitest";
import { renderConsentHtml } from "../oauth/consent-template.js";

const base = {
    clientName: "Demo App",
    clientId: "cid",
    redirectUri: "https://app.example.com/cb",
    redirectUriHostname: "app.example.com",
    scope: "mcp",
    state: "abc",
    codeChallenge: "cc",
    codeChallengeMethod: "S256",
    responseType: "code",
    resource: "",
    nonce: "nonce.token",
};

describe("renderConsentHtml", () => {
    it("escapes client_name HTML", () => {
        const html = renderConsentHtml({ ...base, clientName: "<script>x</script>" });
        expect(html).not.toContain("<script>x</script>");
        expect(html).toContain("&lt;script&gt;");
    });

    it("escapes redirect_uri attribute context", () => {
        const html = renderConsentHtml({ ...base, redirectUri: 'https://a"b.example/' });
        expect(html).toContain('value="https://a&quot;b.example/"');
    });

    it("renders the hostname in bold, full uri in code", () => {
        const html = renderConsentHtml(base);
        expect(html).toMatch(/<strong[^>]*>app\.example\.com<\/strong>/);
        expect(html).toMatch(/<code[^>]*>https:\/\/app\.example\.com\/cb<\/code>/);
    });

    it("posts to /authorize/consent with the nonce + every bound field", () => {
        const html = renderConsentHtml(base);
        expect(html).toContain('action="/authorize/consent"');
        expect(html).toContain('name="nonce" value="nonce.token"');
        expect(html).toContain('name="client_id" value="cid"');
        expect(html).toContain('name="redirect_uri" value="https://app.example.com/cb"');
        expect(html).toContain('name="state" value="abc"');
        expect(html).toContain('name="code_challenge" value="cc"');
        expect(html).toContain('name="code_challenge_method" value="S256"');
        expect(html).toContain('name="response_type" value="code"');
        expect(html).toContain('name="scope" value="mcp"');
    });

    it("includes resource hidden input even when empty", () => {
        const html = renderConsentHtml(base);
        expect(html).toContain('name="resource"');
    });

    it("propagates a non-empty resource value (escaped)", () => {
        const html = renderConsentHtml({
            ...base,
            resource: 'https://api.example.com/"><script>',
        });
        expect(html).toContain(
            'name="resource" value="https://api.example.com/&quot;&gt;&lt;script&gt;"',
        );
        expect(html).not.toContain("<script>");
    });

    it("renders Approve and Deny buttons", () => {
        const html = renderConsentHtml(base);
        expect(html).toContain('name="decision" value="approve"');
        expect(html).toContain('name="decision" value="deny"');
    });

    it("falls back to client_id when client_name is empty", () => {
        const html = renderConsentHtml({ ...base, clientName: "" });
        expect(html).toContain("cid");
    });

    it("escapes ampersands in interpolated values", () => {
        const html = renderConsentHtml({ ...base, state: "a&b" });
        expect(html).toContain('name="state" value="a&amp;b"');
    });

    it("escapes single quotes in interpolated values", () => {
        const html = renderConsentHtml({ ...base, clientName: "Foo's App" });
        expect(html).toContain("Foo&#39;s App");
        expect(html).not.toMatch(/Foo's App/);
    });

    it("escapes attribute-breakout attempts in nonce", () => {
        const html = renderConsentHtml({
            ...base,
            nonce: '"><script>alert(1)</script>',
        });
        expect(html).not.toContain('"><script>alert(1)</script>');
        expect(html).toContain(
            'name="nonce" value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"',
        );
    });

    it("escapes hostname display element", () => {
        const html = renderConsentHtml({
            ...base,
            redirectUriHostname: "<img src=x>",
        });
        expect(html).toMatch(/<strong[^>]*>&lt;img src=x&gt;<\/strong>/);
        expect(html).not.toContain("<img src=x>");
    });

    it("returns a self-contained HTML document with doctype", () => {
        const html = renderConsentHtml(base);
        expect(html.toLowerCase()).toContain("<!doctype html>");
        expect(html).toContain("</html>");
    });

    it("uses POST method on the form", () => {
        const html = renderConsentHtml(base);
        expect(html).toMatch(/<form[^>]*method="POST"/i);
    });

    it("does not include any script tags", () => {
        const html = renderConsentHtml(base);
        expect(html).not.toMatch(/<script[\s>]/i);
    });
});
