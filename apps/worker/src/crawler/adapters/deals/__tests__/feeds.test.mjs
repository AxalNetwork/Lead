// Task #3: Deal-feed adapter routing + headline-extraction smoke tests.

import { test } from "node:test";
import assert from "node:assert/strict";

const { pickAdapter, runAdapter } = await import("../../../../../test-dist/crawler/adapters/index.js");
const { extractDealFromHeadline, parseFeed, buildDealAdapterResult } =
  await import("../../../../../test-dist/crawler/adapters/deals/_shared.js");

test("deal_techcrunch_funding: routes via pickAdapter", () => {
  assert.equal(
    pickAdapter("https://techcrunch.com/category/venture/feed/")?.id,
    "deal_techcrunch_funding",
  );
});

test("deal_prnewswire_funding: routes via pickAdapter", () => {
  assert.equal(
    pickAdapter("https://www.prnewswire.com/rss/financial-services/venture-capital-news.rss")?.id,
    "deal_prnewswire_funding",
  );
});

test("deal_businesswire_funding: routes via pickAdapter", () => {
  assert.equal(
    pickAdapter("https://www.businesswire.com/portal/site/home/news/industries/?venture=1")?.id,
    "deal_businesswire_funding",
  );
});

test("deal_crunchbase_news: routes via pickAdapter", () => {
  assert.equal(
    pickAdapter("https://news.crunchbase.com/feed/")?.id,
    "deal_crunchbase_news",
  );
});

test("deal_venturebeat_funding: routes via pickAdapter", () => {
  assert.equal(
    pickAdapter("https://venturebeat.com/category/funding/feed/")?.id,
    "deal_venturebeat_funding",
  );
});

test("parseFeed: parses an RSS 2.0 fixture", () => {
  const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title><![CDATA[Acme raises $42M Series B led by Sequoia]]></title>
    <link>https://news.example.com/acme-series-b</link>
    <description><![CDATA[Acme today announced it has raised $42 million in Series B funding led by Sequoia Capital, with participation from Andreessen Horowitz and Index Ventures.]]></description>
    <pubDate>Mon, 12 May 2025 14:00:00 GMT</pubDate>
    <guid>acme-1</guid>
  </item>
  <item>
    <title>BigCo to acquire SmallCo for $1.2 billion</title>
    <link>https://news.example.com/bigco-smallco</link>
    <description>BigCo today announced it has agreed to acquire SmallCo for $1.2 billion in cash.</description>
    <pubDate>Tue, 13 May 2025 09:00:00 GMT</pubDate>
  </item>
</channel></rss>`;
  const items = parseFeed(xml);
  assert.equal(items.length, 2);
  assert.match(items[0].title, /Acme raises/);
  assert.equal(items[0].link, "https://news.example.com/acme-series-b");
  assert.ok(items[0].pubDate?.startsWith("2025-05-12"));
});

test("extractDealFromHeadline: funding round with lead + amount + round", () => {
  const cand = extractDealFromHeadline(
    "Acme raises $42M Series B led by Sequoia",
    "Acme today announced it has raised $42 million in Series B funding led by Sequoia Capital, with participation from Andreessen Horowitz and Index Ventures.",
    "https://news.example.com/acme",
    "2025-05-12T14:00:00.000Z",
    "tech_press",
  );
  assert.ok(cand, "candidate should be extracted");
  assert.equal(cand.event_type, "funding_round");
  assert.equal(cand.company_name_raw, "Acme");
  assert.equal(cand.round_name, "Series B");
  assert.equal(cand.amount_usd, 42_000_000);
  assert.ok(cand.lead_investors.includes("Sequoia Capital") || cand.lead_investors.includes("Sequoia"));
  assert.equal(cand.source_type, "tech_press");
  assert.equal(cand.announcement_date, "2025-05-12");
});

test("extractDealFromHeadline: acquisition headline", () => {
  const cand = extractDealFromHeadline(
    "BigCo to acquire SmallCo for $1.2 billion",
    "BigCo today announced it has agreed to acquire SmallCo for $1.2 billion in cash.",
    "https://news.example.com/m-and-a",
    "2025-05-13T09:00:00.000Z",
    "press_release",
  );
  assert.ok(cand);
  assert.equal(cand.event_type, "acquisition");
  assert.equal(cand.company_name_raw, "SmallCo");
  assert.equal(cand.amount_usd, 1_200_000_000);
  assert.ok(cand.lead_investors.includes("BigCo"));
});

test("extractDealFromHeadline: refuses junk", () => {
  assert.equal(
    extractDealFromHeadline("Hello world", "lorem ipsum", "https://x.com", null, "tech_press"),
    null,
  );
});

test("buildDealAdapterResult: end-to-end on a small feed", () => {
  const xml = `<rss><channel>
  <item><title>Acme raises $42M Series B led by Sequoia</title><link>https://x.com/a</link><pubDate>2025-05-12</pubDate><description>led by Sequoia Capital</description></item>
  <item><title>Junk title</title><link>https://x.com/junk</link><pubDate>2025-05-13</pubDate><description>nothing useful</description></item>
</channel></rss>`;
  const r = buildDealAdapterResult("deal_techcrunch_funding", xml, "https://techcrunch.com/category/venture/feed/", "tech_press");
  assert.equal(r.adapter_id, "deal_techcrunch_funding");
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].profile_type, "deal_announcement");
  assert.ok(r.confidence >= 0.5);
  assert.ok(r.child_urls.length >= 1);
});

test("runAdapter: invokes the techcrunch adapter on a feed URL", () => {
  const xml = `<rss><channel>
  <item><title>Acme raises $42M Series B led by Sequoia</title><link>https://techcrunch.com/2025/05/12/acme</link><pubDate>2025-05-12</pubDate><description>Series B led by Sequoia Capital</description></item>
</channel></rss>`;
  const r = runAdapter("https://techcrunch.com/category/venture/feed/", xml);
  assert.ok(r.result, "adapter should produce a result");
  assert.equal(r.used_adapter_id, "deal_techcrunch_funding");
  assert.equal(r.result.candidates[0].profile_type, "deal_announcement");
});
