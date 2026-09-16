# Service resource audit

Each entry records semantic API/lifecycle review and distinguishes deployed evidence from account limitations.

## AI.CustomTopics

Reviewed whole topic-list PUT, zone scope, singleton baseline capture/restore and order-insensitive comparison. Replaced ambiguous delimiter identity with JSON tuples. Typed entitlement probe/list pass; topic-policy mutation requires subscription.

## AI.Dataset

Reviewed full create/update surface (name,enable,filters with all14 keys/four operators/scalar union), scope replacement, observed normalized state, name collision recovery and paginated discovery. Cold matches now Unowned. Typed child/parent absence and immutable stable ids covered; generated names preserved centrally. Existing deployed lifecycle tests run again after ownership change.

## AI.Evaluation

Reviewed all immutable inputs (datasets,evaluation types,name,gateway/account), replacement, observed status and typed absence. Cold matches now Unowned; concurrent name recovery rejects a different dataset set. Evaluation type ids are only observable after results exist, so cached desired ids remain necessary; adoption cannot prove pending type configuration. No fake local job completion.

## AI.Gateway

Reviewed create/update shape and nested retry/billing/guardrail fields, account/id replacement, typed get-create collision recovery and post-create sync, typed deletion/list. Earlier added missing features and normalized nullable response guards. Reconcile currently sends PATCH even when forced with unchanged observed configuration; no versioned resource churn or false output. Optional advanced settings selectively forwarded; entitlement combinations remain gated.

## AI.GatewayDynamicRouting

Reviewed all six graph variants and nested edge/model/rate fields against SDK, account/gateway scope replacement, versions/deployment drift and paginated hydration. Removed destructive rename-collision handler that deleted an unrelated route. Actual two-resource conflict fixture verifies both survive unchanged; whole suite5/5. Cold discovery now Unowned. End node outputs follow documented empty terminal semantics despite SDK permissive map.

## AI.GatewayProvider

Reviewed complete provider/alias/secret/default/rate configuration and list-only API with replacement. Fixed helper pagination beyond50 and cold Unowned read. A mismatching occupant can only be deleted when its id equals persisted currentId; foreign occupants fail typed GatewayProviderOwnershipConflict. Secret readiness/create conflict retries bounded. Full helper no longer infers ownership merely from matching alias. Deployed existing lifecycle/secret replacement/list suite passed29.9s after guard; concurrent foreign-occupant branch is statically reviewed, not induced.

## AI.SearchInstance

Reviewed namespace/id/source/type/embedding replacement and SDK-derived nested source/index/retrieval/public-endpoint settings. Fixed adoption diff dereferences of absent olds and write-only tokenId-only rotation (prior props comparison; always sync on adoption). Earlier added hybridSearchEnabled plus update-only summarization/model/prompts. Selective omitted fields preserve observed config; initial-index error is explicitly best effort warning. Runtime remains remote search/inference, no fake index. Actual replacement/recovery hit code7001 Internal Error, previously mistyped ValidationError. Added precise AiSearchInternalError SDK matcher and bounded retries; updated R2 CRUD/replacement/recovery/namespace/list5 passed. Crawler recheck after unrelated Flagship import fix passed1/1; all six actual lifecycle cases passed across final rerun+focusedrecheck.

## AI.SearchToken

Reviewed all five create/update fields, account replacement, paginated natural-key discovery, write-only key comparison via olds, typed absence and dependency delete. Cold matches now Unowned; legacy omission converges false consistently with create. Delete retries reduced from60x5sec to8x5sec; credential propagation exponential capped5sec. Explicit legacytrue creates tokens that API per-id routes cannot manage; documented service limitation.

## AI.SecuritySettings

Reviewed sole enabled setting, zone identity, observed no-op and baseline capture/restore. Exact entitlement probe plus list pass; mutating policy gated.

## Alerting.NotificationPolicy

Reviewed all writable policy fields and SDK-derived filters/mechanisms, account/alert-type replacement, Unowned natural-key lookup and typed delete. Description removal explicitly clears; API3/3 verifies it. Exact BadRequest17009 probe proves universalSSL rejects alertInterval30m. Official docs provide no universal default, so omitted interval leaves existing value unmanaged and no longer causes repeated dirty PUT; explicit interval forwarded when supported.

## Alerting.Silence

Reviewed bulk create/update mapping and tuple identity lookup, instant-normalized timestamps, typed concurrent SilenceAlreadyExists recovery, post-create discovery and typed delete. Bounded create discovery to 8 retries with 5-second delay cap. Policy/account replacement and Unowned cold lookup present. Existing actual deployed create/window-update/replacement/list passed.

## Alerting.Webhook

Reviewed name/url/secret create/update, account identity, observed equality and write-only secret prior-props comparison. Bounded create retries8 (~32sec). Existing real deployed destination Worker fixture passed; later whole-directory WorkerURL404 is separate runtime incident.

## ApiShield.Configuration

Reviewed complete authIdCharacteristics list and baseline restoration. Added API normalize query flag to reads/writes and forces write when explicitly changed. Config lifecycle requires API Shield entitlement; suite12passed1gated does not verify normalize mutation.

## ApiShield.Label

Reviewed name identity and metadata map, short physical-name limit, typed missing/list hydration and replacement. Added metadata forwarding/read/deep comparison. Actual4/4 includes metadata create/update/name replacement/list.

## ApiShield.Operation

Reviewed complete method/host/endpoint input surface, endpoint variable-name canonicalization, cold discovery, Unowned adoption and typed absence. Diff now guards unresolved input and compares output identity on adoption. Deployed ApiShield12passed1gated includes operation create/replacement/list.

## ApiShield.UserSchema

Reviewed schema multipart source/name/kind/validation input, immutable configuration and observed schema source. Diff now compares adopted output instead of returning early without olds; schema source/name/validation/zone changes replace. Deployed create/replacement/list passed within ApiShield12passed1gated.

## BotManagement.BotManagement

Reviewed15 mutable APIsettings, observedsubsetcomparison, fullbaselinecapture and typedzoneabsence. Fixed historicalmanagedKeys so props removedbeforedelete stillrestoretheirinitialvalue. managedKeys notstable. StaleZoneConfiguration is serverdiagnostic ratherthanwritablepolicy. Traffic-changing lifecyclefixture gated to avoidchallenging everyother deployedzonefixture; noop/list actualtests run.

## Cache.OriginCloudRegion

Reviewed complete vendor/region/body+path IP fields, zone/IP replacement, get-or-upsert convergence, Unowned cold lookup, typed absent deletion and zone pagination. IP equality only trims/lowercases; equivalent expanded/compressed IPv6 may cause unnecessary replacement, not loss of requested state.

## Cache.RegionalTieredCache

Reviewed on/off value API, enabled default true, zone replacement, baseline capture and observed restore. Fanout transient-auth retry capped8x5seconds. Entitlement handling specific and no broad catches; deployment depends on paid plan.

## Cache.Reserve

Reviewed toggle baseline lifecycle plus asynchronous clear API. Fixed clearOnDelete: disable before clear, check In-progress before starting, return after accepted async clear instead of300second poll falsely accepting incomplete. Explicit clear leaves Reserve disabled; normal delete restores initialValue. Official docs say clear may take24h and cannot re-enable meanwhile. Disposable entitled-zone fixture added, current profile typed SettingUnavailableForPlan prevents clearing test.

## Cache.SmartTieredCache

Reviewed on/off translation with enabled default true, zone replacement, live observation no-op, baseline capture and observe-before-restore deletion. Fanout skips typed plan/auth/route rejects; no unexplained retries.

## Cache.Variants

Reviewed all11 supported extension arrays against SDK, null/empty normalization, observed whole-value comparison and PATCH mapping, typed unconfigured/route absence and DELETE. Unlike toggle singletons it has true CRUD, but cold read is not Unowned and delete removes existing configuration; ownership behavior remains a review finding.

## Calls.App

Reviewed full provider: name-only create/update API surface, account replacement, live get before update/create, typed delete absence; generated-name preservation fixed centrally. Secret is create-only and retained from cached output. Without persisted secret no meaningful read/adoption recovery is possible; list emits an empty redacted placeholder. Existing deployed lifecycle/list passes; lost-secret behavior is an explicit limitation.

## Calls.TurnKey

Reviewed full provider parallel to Calls.App: name-only API surface, account replacement, get before mutation, typed absence, create-only key retained. Generated-name preservation fixed centrally. Cold state cannot reconstruct key from get/list; empty redacted list placeholder is not a usable key. Existing deployed lifecycle/list passes.

## CloudConnector.Rules

Reviewed ordered whole-list PUT, all four provider variants and host field, enabled default and observed no-op. Live experiment found API changes rule id when contents change despite supplied id; id is diagnostic, not convergent desired state, so no misleading input was added. Final deployed3/3 passed; experiment was removed from fixtures.

## CloudforceOne.ScanConfig

Reviewed all three writable fields, account replacement, list-only observation and typed update-race recovery. Cached-id lookup now exhausts pages; removed frequency/ports reset documented0/[default]. No natural key or get-by-id exists, so complete loss of id cannot safely recover. Subscription rejection probe verified; mutating defaults/pagination branch requires entitlement.

## Connectivity.DirectoryService

Reviewed fourhostunions (IPv4/IPv6/dualstack/hostname resolver), all ports/type/appProtocol/TLS inputs, typed namecollision recovery, live idthenname observation, Unowned coldread and accountreplacement. Optional ports/TLS fields use patch-style management (undefinedpreservesexisting); resolverIPs sorted for comparison. Source matches sameSDK used by VpcService; existing live lifecycle4passes but broaderoptionremoval unverified.

## ContentScanning.ContentScanning

Reviewed enabled/disabled API, nullable disabled default, zone replacement, singleton baseline capture, observed no-op and typed absent restore. List enumerates zones and handles explicit entitlement/route errors. Local subset would require WAF request parsing and malware scanner; absent intentionally rather than fake pass.

## ContentScanning.Expression

Reviewed sole payload identity and immutable zone, paginated observation, Unowned matching, create-list result validation and observe-before-delete. Disabled parent maps to unobservable absence; reconcile correctly requires enabled scanning. Payload/ID are API-optional but persisted response assumed valid; missing id after create remains schema/API anomaly. Remote edge extraction not emulated.

## Diagnostics.EndpointHealthcheck

Reviewed endpoint/name/checkType SDK mapping, ICMP-only API, immutable name replacement due observed API behavior, account scope, Unowned exact-name discovery, typed absence and bounded missing observation. Name not unique; cold lookup deterministically chooses id. API optional id still assumed present on successful create; actual endpoint lifecycle depends on private-network onboarding.

## Email.Address

Reviewed email-only immutable identity/account diff, paginated address lookup, GET id usage, same-address cooldown recovery and typed delete. Removed blanket retry of every failure except cooldown; SDK transport retries are authoritative. Deletion cooldown15minutes requires standing retained fixture; current token lacks routing scope.

## Email.AllowPolicy

Reviewed supported policy booleans/pattern/regex/comments, paginated pattern lookup and Unowned cold read. Added missing account replacement and comments removal clearing. Deprecated recipient/sender/spoof aliases are excluded in favor of supported replacements. Natural pattern lookup can encounter differing patternType; explicit adoption is required.

## Email.CatchAll

Reviewed all action union variants, constant all matcher, mutable enabled/name, resolved zone replacement and baseline capture/restore. Removed Forbidden suppression in read/delete; authorization failure no longer looks like absence/success. Missing captured Worker/address target explicitly falls back to disabled drop on restoration. Official API spec confirms source(api|wrangler) and ownerWorkerTag are writable; now exposed, forwarded, observed and included in initial restoration metadata. Current routing scope gate prevents Wrangler branch mutation. Final response-schema check: ownerWorkerTag is write-only. Last written tag is cached and compared with prior desired props. Original Wrangler ownership is not recoverable from a cold API read; if restoration needs an unavailable original tag, delete fails explicitly with CatchAllRestoreOwnerUnavailable. No invented SDK read field or false successful restoration.

## Email.ImpersonationRegistryEntry

Reviewed name/email/regex/comments fields, paginated tuple lookup and Unowned adoption, typed get/delete absence. Added account replacement and comments removal clearing. Directory linkage fields are external directory integration metadata; manual entry management does not synthesize directory identities. Current scope/entitlement lifecycle gated.

## Email.Routing

Reviewed enable/disable endpoints and zoneReference replacement, observed enabled no-op and deletion. Removed blanket deletion failure suppression; auth/API errors propagate. Routing DNS setup uses external provider edge, no fake local routing control plane. Actual send_email local runtime handled independently.

## Email.Rule

Reviewed action/matcher unions, observed update/create flow, name/id recovery and typed absence. Removed broad failed-update create fallback and added observed no-op. Account zone scope and Worker dependency retries explicit. Name metadata/default behavior follows API; destination verification and routing scope gates prevent current full lifecycle. Official API spec confirms source(api|wrangler) and ownerWorkerTag are writable; both now exposed, forwarded and observed. Wrangler branch requires configured routing scope and real owning script tag, not exercised by current profile. Final response-schema check: ownerWorkerTag is write-only, so output retains last configured tag and dirty comparison uses cached state; source is observable. No SDK response field invented.

## Fraud.DetectionSettings

Reviewed userProfiles,usernameExpressions and nestedstatus-code success/failurecriteria; subsetmanagement and fullbaselinecapture. Fixed historicalmanagedKeys restorationafterpropre moval; addedrealdeployno-op historyfixture and extendedgatedmutatingrestorecase. Typedsubscriptionprobe observed; partialnullauthenticationfields normalize.

## GoogleTagGateway.GoogleTagGateway

Reviewed all five PUT fields, Reference resolution and zone replacement, nullable unconfigured response, baseline capture and restored configuration on delete; absent baseline disables endpoint. setUpTag omission intentionally preserves observed value. Equality covers all five fields; no untyped suppression.

## Healthcheck.Healthcheck

Reviewed all nested HTTP/TCP request fields, mutable defaults, observation, name recovery and deletion. Added resolved-input and adopted zone identity guards. A typed create conflict now flows through desired-state synchronization instead of being mistaken for a successful create. Deployed5/5; concurrent create collision not induced.

## Images.Variant

Reviewed fit/width/height/metadata/neverRequireSignedURLs fields, account/name identity, observed update and typed missing handling. Fixed arbitrary variant-name response map and exhausted list; deletion confirmation bounded8x2seconds fails if still present. Deployed3/3. Native image processing itself separate runtime scope.

## Intel.IndicatorFeed

Reviewed create-then-sync update-only visibility flags, cached-id/name recovery, snapshot SHA256 write tracking and final re-read. No delete API; resource explicitly retains feed. Description omission preserves existing value; snapshot removal does not clear upstream content, and hash cache cannot detect out-of-band snapshot drift. Existing tests gated; do not claim content convergence for unsupported observation/deletion.

## Intel.IndicatorFeedPermission

Reviewed feedId/account/grantee identity and additive grant/revoke operations. API offers no grantee read, so cached identity and idempotent PUT are honest limited observation; absent feed typed deletion. No false remote-state read claim.

## LoadBalancer.LoadBalancer

Reviewed parent zone identity, named pool/fallback/location/affinity/adaptive-routing/proximity/random/steering fields and nestedrules/networks SDK types. Added networks/rules props and full deep observed comparison. Optional body defaults/removal selectively managed per API; LB service entitlement gates end-to-end traffic verification.

## LoadBalancer.Pool

Reviewed account/name, origins/headers/load-shedding/geo/health notifications and update-only checkRegions. Create now continues through sync to apply update-only field. Physical name preservation and bounded monitor readiness retries; paid entitlement gates active balancing behavior.

## Logpush.Job

Reviewed account/zone operation dispatch, immutable dataset/kind/scope, secret-redacted destination and omitted filter comparison via olds, observed defaults/subset output options, paginated name recovery and typed delete. Added supported legacy frequency/logpullOptions forwarding and dirty comparison; live R2 destination fixture verifies low/high frequency and legacy logpull options. Optional output/batch field omission intentionally preserves server settings; explicit resets require API-supported values. Existing dataset replacement test remains TODO.

## MagicNetworkMonitoring.Config

Reviewed all four mutable fields and nested WARP-device tuples, account replacement, nullable absent response, Unowned adoption, concurrent-create/update-null recovery and true delete. Replaced ambiguous WARP tuple string serialization with JSON tuples. Actual config create/update/delete/list included4/4 MNM suite.

## MagicNetworkMonitoring.Rule

Reviewed every threshold/zscore/advanced_ddos field, immutable type, observed duration normalization, typed conflicts and missing delete. Fixed default-account change replacement, paginated name lookup and create-conflict recovery continuing through sync; bounded ConfigMissing retry under40sec. Optional type-specific thresholds preserve omitted state, explicit API values supported. Actual threshold update/type replacement/list included4/4 MNM suite.

## NetworkInterconnects.Settings

Reviewed sole defaultAsn API field, baseline capture, observed no-op/restore and enterprise list probe. Added missing account replacement and read uses original cached account, preserving correct baseline when ambient account changes. No real cross-account fixture available; current entitlement gate records limitation.

## Organization.Organization

Reviewed full provider and Profile/Flags contracts. Parent id replacement, Unowned cold exact-name lookup, typed get/delete absence, observed name/profile comparison; profile omission intentionally preserves observed profile. Name generator drift fixed centrally. Fixed exact parent matching so an omitted parent cannot select a same-name child organization. Live entitlement gate remains.

## OriginPostQuantumEncryption.OriginPostQuantumEncryption

Reviewed complete three-value API, supported default, observed no-op, initialValue capture survives refresh/adoption, zone replacement and observe-before-restore delete. InvalidZoneIdentifier only treated as absence. Unknown future observed values normalize to supported; current SDK enum fully handled.

## PageShield.Policy

Reviewed all five mutable API fields, live observation, natural-name lookup and delete. Cold lookup now exhausts pagination and generated description preserves observed value. Actual updated suite pending.

## PageShield.Settings

Reviewed all three mutable booleans and API defaults(true,true,false), baseline capture and full restoration. Zone identity replacement present. SDK has no typed zone-absence error for this operation; deleted-zone cleanup remains unverified.

## Pages.Deployment

Reviewed immutable deployment request body and fields as snapshot: branch/commit/build/content/envVars/functions/routes/headers/redirects/config. Added12 omitted fields and replacement on immutable props. API-supplied multipart assets are caller responsibility, not build pipeline synthesis. Actual same-branch/cross-project tests pass; bounded retries maintained by parent.

## RealtimeKit.App

Reviewed name-only creation, explicit unsupported rename/no-delete retention, accountreplacement, cached-id and name lookup. Fixed both lookups to exhaust app pagination via shared lookup (formerly first page only). Missing create id now fails instead of returning empty id. Deployed list fixture also traverses perPage1; RealtimeKit entitlement probe determines whether lifecycle actually runs.

## RealtimeKit.Preset

Reviewed nested config/UI/permissions against all SDK create/update input interfaces. Added8 omitted fields: simulcast,livestreamViewerQualities,acceptStageRequests,stageAccess,stageEnabled,transcriptionEnabled,fontFamily,googleFont, including read projections. Fixed cold name recovery beyondfirst100 presets; full app/presetlist pagination nowshared. SDK requireddefaults built forfullPUT, observedsubset equality ignoresserverextras; option omission resetswholeconfig/UI/permissions todefaults but nestedoptional omissions preserveAPIdefaults.

## RealtimeKit.Webhook

Reviewed nineevent types, enabled defaulttrue, app/account replacement, observed full body comparison with event-order normalization, typed duplicate-name recovery and missingdelete. Fixed app enumeration to paginate; webhook endpoint itself has no pagination arguments. Cold foreign name match is adopted without ownership marker, remaining policy difference.

## Registrar.Domain

Reviewed three mutable settings, read-only domain status and account scope. Added account replacement guard and historical managedKeys, so removed settings still restore their baseline while unrelated settings are preserved. Existing registration is required; no domain purchase performed. New restoration branch awaits configured-domain live verification.

## Rum.Rule

Reviewed host/paths/inclusive/isPaused API fields and ruleset identity. Omitted paths now resets to[], inclusive totrue and isPaused tofalse; previous code preserved observed values. Deployed8/8 Rum suite includes API-verified removal. Host omission remains patch-style preservation because SDK offers no clear sentinel.

## Rum.Site

Reviewed create/update fields, paired site/ruleset reads and zone identity. Added resolved/adopted-output replacement guard and autoInstall defaultfalse on creation/update. Deployed8/8 Rum suite verifies true-to-omitted reset. Omitted lite/enabled management remains selective.

## SecurityTxt.SecurityTxt

Reviewed all RFC9116 fields, observed normalized full PUT, Unowned cold read and typed deletion. Actual4/4 suite now verifies removal of all five optional arrays and language directly through API; omitted values clear correctly. Bounded transient-auth retries under40sec.

## Snippets.Snippet

Reviewed full multipart upsert and raw download MIME/source, entrypoint identity cache, name replacement and dependent-rule teardown. Exposed typed files plus code shorthand with duplicate/mainmodule validation. Actual5/5 covers multicomodule update/removal and no-op timestamp preservation. Binary download is text-decoded, so binaryuploads conservatively reupload; mainmodule metadata not observable.

## Snippets.SnippetRules

Reviewed ordered whole rule list, enableddefault and snippet-reference ordering, zone scope and true rule clearing. Typed requested-zone-not-found400 SDK correction makes never-provisioned delete idempotent. Actual5/5 snippets suite includes rule lifecycle/list/dependent teardown.

## Speed.TestSchedule

Reviewedurl/region scopeidentity, createandobserve withtypedAlreadyExists, frequencydelete-create withquota rollback, paginatedzonelist and typeddelete. Fixed resolved-input/adoptedoutputdiff and frequencyremovalreset via APIdefault; fixedfieldurl/region remainstablewithinupdate. Currentdailycreationquota gates repeatedmutations; all recreation errors now attempt restoring the old schedule and preserve original failure; rollback itself can also fail and is surfaced.

## Stream.LiveInput

Reviewed recording,RTMPS/SRT/WebRTC outputs,meta,enabled/default-recording/hide/lifetime/low-latency fields, account scope and typed absence. Added preferLowLatency mapping and SDK bare-array/count response support; deployed3/3. Recording nullable retention reset still unverified on vendor service.

## Tags.AccountResourceTags

Reviewed whole tag-map PUT/remove behavior, ETag output and Unowned cold adoption. Fixed account/type/resource/optional-worker identity comparison using adopted outputs; removed nested Input type in Props. Read treats empty map as absence because API does not distinguish it. ifMatch is optimistic-concurrency precondition, not desired state; no ETag-based retry protocol implemented. Deployed Tags7/7.

## Tags.ZoneResourceTags

Reviewed zone/type/resource/optional-access-parent path scope, whole tag replacement, typed missing-resource reads and create visibility retries. Fixed adopted-output/optional-parent removal replacement and resolved guard; removed nested Input in Props. Parent bounded shared retry helper. Current API ETag retained as output only, concurrent external writes can be overwritten by authoritative desired map. Deployed Tags7/7.

## TokenValidation.Configuration

Reviewed metadata/JWKS key union and title identity, paginated cold lookup, oldest deterministic match and observe/update/delete typed missing. Existing TokenValidation.test fixture covers key rotation; API Shield entitlement gates mutation. No local token validation policy runtime implemented.

## Turnstile.Widget

Reviewed all mutable/immutable create/update fields, account/region replacement, secret hydration via GET, paginated name discovery and typed absence. Cold name match now Unowned. Omitted booleans resetfalse and clearance resetsno_clearance; actual4/4 suite verifies jschallenge removal through API plus out-of-band delete recovery. Collection order/direction/page controls are not widget configuration.

## VpcService.VpcService

Reviewed four host unions, HTTP/TCP type/ports/appProtocol/TLS mapping, account replacement, exact name recovery and typed collision/missing errors. All discovered omitted fields added and live HTTP/IPv4/dual-stack/list plus TCP/TLS invalid-config probe verified. Optional unset ports/TLS follow API selective-management semantics.

## VulnerabilityScanner.Credential

Reviewed all create/update fields (name/location/locationName/value), credential-set/account replacement, live read then name lookup, Unowned cold match, both parent/child typed absence, write-only Redacted value compared against olds and applied on adoption. Generated-name preservation fixed centrally. Missing-update race propagates typed failure rather than duplicate creation; lifecycle requires vulnerability-scanner entitlement.

## VulnerabilityScanner.CredentialSet

Reviewed name-only create/update API, account replacement, get/name fallback, deterministic duplicate selection, Unowned cold lookup, typed deletion. Generated-name preservation fixed centrally. Lifecycle entitlement gated.

## VulnerabilityScanner.TargetEnvironment

Reviewed target zone union (only zone supported by SDK), name/description forwarding, null clears removed description, account/zone replacement, get/name fallback and Unowned cold read, typed delete. Generated-name preservation fixed centrally. Cold same-name lookup does not filter zone before adoption (explicit adoption needed); lifecycle entitlement gated.

## WaitingRoom.Settings

Reviewed sole searchEngineCrawlerBypass boolean, defaultfalse, zone replacement, baseline capture/read/no-op/restore and typed zone absence. Exhaustive zone list with bounded auth retry. Current actual tests include gated entitlement branches.

## WaitingRoom.WaitingRoom

Reviewed all22 mutable API fields including route/cookie nested structures, zone identity, paginated exact-name Unowned lookup and typed deletion. Fixed known-default removal: when observed nondefault, PUT now explicitly sends documented reset values instead of comparing against default but omitting mutation. Advanced options without documented resets remain selectively managed. Entitled real lifecycle needed to verify default removal branch.

## Web3.ContentList

Reviewed full configuration plus three entry fields through separate content-list/config APIs. Ordered replacement and empty-list clearing covered. Replaced delimiter-based equality with collision-free JSON tuples. Cold read currently lacks Unowned marker; actual updated suite pending.

## Web3.Hostname

Reviewed immutable zone/name/target, typed absent get/delete, deleting-state filtering and Unowned natural-key recovery. All supported API inputs mapped. Omitted description/dnslink preserve observed values; API clearing semantics unverified.

## Zaraz.Config

Reviewed SDK-derived settings/analytics/consent plus arbitrary tools/triggers/variables; workflowseparateAPI, zoneReference replacement, full liveconfig merge preservesomittedprops and serverzarazVersion, stripsnulls/unwrapsRedacted values. Defaultdelete retainsconfig; opt-indelete resetsAPIdefaults/workflow. Stables onlyzoneId. Secret variable comparison masksserverredaction in diff; reconcile stillcomparesrawobservation, so forcedreconcile may reupload secrets.

## Zone.Setting

Reviewed heterogeneous setting value map, zone/name replacement, observed value/baseline restore and zone-wide list. Removed blanket read/list catch; real UndefinedZoneSetting400 modeled in SDK and caught precisely. Full setting-specific validation belongs to API; deployed4/4 includes baseline/replace/list. Final SDK review found ssl_recommender uses top-level enabled rather than value; boolean value mapping/read/restore and known-id listing now implemented. Actual standing zone rejects GET with typed UndefinedZoneSetting400; ungated probe pins it and full toggle fixture is environment-gated. Final suite5passed1gated; enabled-mapping fixture implemented but cannot run against current unavailable setting.

## Zone.Zone

Reviewed account/name/type identity, live create/get/activation/deletion and paginated cold name lookup. Typed InvalidZoneIdentifier alone maps absence; prior blanket catch removed. Account-global zone ownership and asynchronousactivation cannot be emulated by metadata CRUD. Domain delegation remains external.
