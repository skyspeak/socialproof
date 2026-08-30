import type { DigestView } from "@/db/queries";

/**
 * A specimen issue so the magazine can be read and typeset without a live
 * press run. Labeled as such on /preview — never mixed into `/`.
 */
export const FIXTURE_DIGEST: DigestView = {
  id: "fixture",
  date: "2026-08-30",
  status: "published",
  headline:
    "Two labs shipped agent frameworks on the same afternoon, and the plugin argument is over.",
  intro:
    "A quiet Sunday broke open when the releases landed an hour apart. The interesting part is not the coincidence. It is that both independently arrived at the same shape: a thin runtime, a hard boundary around tools, and a bet that the next year of product work happens in the plugins. Meanwhile the open-model forums spent the day on a RISC-V thread that is really about toolchains, and three senior people moved without a blog post to explain themselves.",
  itemCount: 64,
  generatedAt: new Date("2026-08-30T13:04:00Z"),
  windowStart: new Date("2026-08-29T13:00:00Z"),
  windowEnd: new Date("2026-08-30T13:00:00Z"),
  provider: "gemini",
  edition: "editorial",
  prevDate: "2026-08-29",
  nextDate: null,
  themes: [
    {
      id: "t1",
      name: "Agent frameworks converge on plugins",
      summary:
        "LabOne and a second independent release both treated the model as a guest in a host that owns tools, memory, and permissions. The documentation reads like a retraction of last year's 'the model will just call APIs' demo. People who had been wiring their own function-calling loops said they would throw the loops away; people who sell hosted agents said the abstraction was what they had been waiting to productize. The disagreement left is not whether plugins, but who is allowed to write them.",
      soWhat:
        "When two labs ship the same shape in an hour, the industry is no longer exploring. It is standardizing.",
      isNew: true,
      desks: ["Hacker News", "Techmeme", "Simon Willison"],
      continuedFrom: null,
      items: [
        {
          id: "i1",
          title: "LabOne ships an agent framework built entirely on plugins",
          url: "https://example.com/a",
          discussionUrl: null,
          sourceName: "Hacker News",
          score: 420,
          commentCount: 180,
          imageUrl: null,
        },
        {
          id: "i2",
          title: "A second lab, same afternoon, same boundary around tools",
          url: "https://example.com/b",
          discussionUrl: null,
          sourceName: "Techmeme",
          score: 12,
          commentCount: null,
          imageUrl: null,
        },
        {
          id: "i3",
          title: "Notes on throwing away a year of function-calling glue",
          url: "https://example.com/c",
          discussionUrl: null,
          sourceName: "Simon Willison",
          score: null,
          commentCount: null,
          imageUrl: null,
        },
      ],
    },
    {
      id: "t2",
      name: "The RISC-V argument is a toolchain argument",
      summary:
        "An embedded engineer’s reply to a week-old critique did not defend the ISA so much as the compiler, the board support, and the decade it takes for that stack to feel boring. The thread ran all day on the forums that still allow it. Several people who had been waiting for a cheap, open core said they were waiting for LLVM to treat it as a first-class target, not for another core dump.",
      soWhat:
        "Instruction sets do not win. The week the compiler is boring, they already have.",
      isNew: false,
      desks: ["Lobsters", "Hacker News"],
      continuedFrom: { date: "2026-08-29", name: "The RISC-V argument reopened" },
      items: [
        {
          id: "i4",
          title: "A 3rd World Embedded Engineer Responds to RISC-V criticism",
          url: "https://example.com/d",
          discussionUrl: null,
          sourceName: "Lobsters",
          score: 88,
          commentCount: 40,
          imageUrl: null,
        },
      ],
    },
    {
      id: "t3",
      name: "Open-weight models keep landing on a Saturday",
      summary:
        "A mid-size lab put weights on a public mirror overnight. The usual sequence followed: a quant by breakfast, a GGUF by lunch, a claim that it matches a closed model on a private eval that cannot be checked. The useful signal was in the comments from people who actually ran it — long-context still falls apart, tool use is the gap, and the license is the part that will matter in a month.",
      soWhat:
        "The eval is marketing. The license and the tool-use failure are the story.",
      isNew: true,
      desks: ["Reddit", "Hugging Face"],
      continuedFrom: null,
      items: [
        {
          id: "i5",
          title: "Weights up, evals unverifiable, license actually interesting",
          url: "https://example.com/e",
          discussionUrl: null,
          sourceName: "Reddit",
          score: 640,
          commentCount: 210,
          imageUrl: null,
        },
      ],
    },
    {
      id: "t4",
      name: "The people who train models are still walking out",
      summary:
        "No single resignation letter dominated, but three names moved in twenty-four hours and none of them filed a blog post. The pattern is becoming the pattern: a researcher leaves a lab that just raised, for a lab that has not, and the public explanation is a one-line LinkedIn update that says nothing. The beat is quieter than last winter and more sure of itself.",
      soWhat:
        "When the announcements get shorter, the reasons are no longer for the timeline.",
      isNew: true,
      desks: ["Techmeme", "People via Exa"],
      continuedFrom: null,
      items: [
        {
          id: "i6",
          title: "Jane Researcher named head of alignment at SmallLab",
          url: "https://example.com/f",
          discussionUrl: null,
          sourceName: "Techmeme",
          score: null,
          commentCount: null,
          imageUrl: null,
        },
      ],
    },
  ],
  people: [
    {
      id: "p1",
      person: "Jane Researcher",
      fromOrg: "BigLab",
      toOrg: "SmallLab",
      role: "Head of Alignment",
      moveType: "new_role",
      confidence: "confirmed",
      note: "Second senior departure from BigLab this month.",
      evidenceUrl: "https://example.com/f",
    },
    {
      id: "p2",
      person: "Omar Khalid",
      fromOrg: "CloudCo",
      toOrg: null,
      role: null,
      moveType: "founded",
      confidence: "reported",
      note: "Incorporated a inference-tooling company. No product page yet.",
      evidenceUrl: null,
    },
    {
      id: "p3",
      person: "Priya Nair",
      fromOrg: "LabOne",
      toOrg: "LabOne",
      role: "VP, Developer Experience",
      moveType: "promoted",
      confidence: "chatter",
      note: "Internal title change circulating; LabOne has not confirmed.",
      evidenceUrl: null,
    },
  ],
  bookmarks: [
    {
      tweetId: "123",
      tweetUrl: "https://x.com/example/status/123",
      author: "demo",
      text: "The plugin boundary is the whole product. Everything else is a demo.",
      links: ["https://example.com/a"],
      images: [
        "https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=800&q=80&auto=format&fit=crop",
        "https://images.unsplash.com/photo-1518770660439-4636190af475?w=800&q=80&auto=format&fit=crop",
      ],
    },
  ],
  sourceHealth: [
    { slug: "hackernews", status: "ok", itemsFound: 42, error: null },
    { slug: "lobsters", status: "ok", itemsFound: 18, error: null },
    { slug: "reddit", status: "skipped", itemsFound: 0, error: "403" },
  ],
};
