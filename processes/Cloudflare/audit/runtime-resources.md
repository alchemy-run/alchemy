# Media and schema resource audit

## Images.SigningKey

List/get existence protects secret rotation; cold read Unowned; effective account replacement now handles removing override; delete remains idempotent except provider correctly surfaces protected last key. Account list is unpaginated capped key collection. Effective account diff corrected. ImagesAccessNotEnabled (5403) lifecycle entitlement; ungated typed probe passes; no second account for replacement.

## Stream.SigningKey

Immutable generated key; preserve write-only PEM/JWK on read; observe existing id before creating; missing id recreated; idempotent typed deletion. List SDK pagination mode single matches API. Cold recovery cannot reconstruct secret material. No missing mutable API fields found. Secret material is only returned at creation.

## Stream.Webhook

Account singleton GET/cold Unowned, PUT full desired URL, immutable account replacement, typed missing delete. Secret preserved from observed response. No pagination. No source changes needed. Deleting/recreating rotates service-generated secret; only empty account slot exercised.

## Stream.Watermark

All fields immutable: replace on change; cold named match now Unowned; adoption compares observed props even without olds; omitted name preserves physical identity; typed missing deletion; list is single API collection. PNG multipart file mode added alongside JSON URL mode. SDK uploadWatermark new multipart operation; local Uint8Array property and source-mode replacement. Adoption/default removal/name preservation regression fixture. Cannot recover original uploaded file bytes; adopting file content requires replacement; download metadata is read-only.

## Stream.LiveInputOutput

Parent/url/key immutable, enabled updates/default true reset, observe missing output before create, typed idempotent delete, account list via parent inputs. Parent API bare-array/count wrapper patch already present. Removed obsolete list gate; tested enabled omission reset and actual parent enumeration. Unlabelled server-generated output id cannot be recovered without state.

## SchemaValidation.Schema

Full source create/read, name/source immutable replacement, default validation true; false->true patch, true->false replacement per API. Paginated name cold discovery Unowned, typed gone delete. Bounded test polling. Schema kind currently API openapi_v3 only.

## SchemaValidation.Settings

Zone singleton GET capture original; PUT full desired with omitted nullable override cleared; destroy restores initial actual settings; immutable zone replacement; no pagination. Fixture now captures actual baseline rather than mutating baseline before capture; verified omitted override reset. No source API-field gaps found.

## SchemaValidation.OperationSetting

Individual operation PUT covers bulk PATCH equivalent fields; null action reads absent; cold Unowned; path identity replacement; typed missing deletion clears override. Parent operation enumeration for listing. Actual deployed test now deletes override while retaining parent operation, then verifies absence. Bulk multi-operation transaction is service operation, not extra per-resource desired state.
