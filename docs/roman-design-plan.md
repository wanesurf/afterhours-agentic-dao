# Roman visual direction

The supplied assembly fresco, with Afterhour standing among its human governors,
is the defining image. The page should feel like a civic institution for holders.

## Tokens

- Limestone `#e5e4dc`: page ground, drawn from the stone architecture.
- Marble `#f1f0e9`: quiet reading surfaces and the chat composer.
- Olive ink `#28332a`: text and primary actions.
- Temple shade `#18221b`: the holder forum background.
- Bronze `#ad9868`: secondary details and dark-surface actions.
- Stone `#62685c`: supporting text, with readable contrast.

Type: Marcellus for Roman-inspired headings and the wordmark; existing Geist for
body text, controls, and balances. No decorative monospace labels or all-caps
eyebrows. Use 16–18px body text, 1.6 line height, at most 65-character measures.

## Layout

Center the short hero statement above an unobstructed panoramic image. Use a
compact masthead with direct links; left-align explanations and conversations.

    Afterhours                    The idea   Holder forum   Realms
                  The Agentic DAO for
                  the tokenized economy.
                One short explanation + chat link
    [             original assembly fresco                   ]

    Markets move fast.        Community policy → agent execution
    Holders set the course.   Brief explanation and governance link
    [Holders decide]       [Agent acts]       [Everyone verifies]

    [ Deep olive holder forum                                 ]
    [ Your DAO. Your questions.     Afterhour / Read only      ]
    [ Eligibility + token link     Wallet gate / conversation ]

## Review before implementation

A generic parchment page with ornamental columns or unrelated laurels would
compete with the image. Keep the actual classical architecture in the supplied
artwork and use proportions and type elsewhere. The banner is the one bold
visual. Bronze supports it; there are no gradients, glass strips, looping motion,
or decorative step numbers. The chat remains a clear functional surface, with
existing authentication states and backend behavior preserved.

## Responsive intent

At phone widths the masthead and headline compact, the banner uses a centered
crop that preserves Afterhour, and the forum becomes a single column. Controls
remain at least 44px tall. The entire page is static except native user actions.

## Implementation review

Verified the landing hero, explanation, holder forum, and wallet selector in the
local browser. At 390px and 320px the page has no horizontal overflow; the mobile
artwork crop keeps Afterhour centered. Both image assets load and the heading
uses Marcellus. The market monitor shares the same palette and type. The local
production build passes. GSAP and its animation controls are removed from the
client and package dependencies. Existing holder authentication is preserved;
live Hermes replies still require the existing server connection configuration.
