# TrustCar database models

The database models are part of the main backend now. The active API models in
`src/models/` were kept unchanged so the existing authentication, car APIs, and
seeders continue to work.

The ERD-only models were converted to ES modules and added alongside them:

- Brand
- ChatConversation and ChatMessage
- ContentItem
- Feedback
- InteractionEvent
- LeadActivity, LeadTask, and LeadVehicleInterest
- Permission
- RecommendationBatch
- SaleRecord
- ShowroomService
- SystemSetting
- ValuationRule
- VisitorSession

`src/models/index.js` registers the complete model set at startup. Existing
collections such as `users`, `roles`, and `cars` are not dropped or replaced.
MongoDB creates the new collections when the first document is inserted and
Mongoose creates their indexes during startup in development.

The ERD and its change log are stored in this folder. Do not commit `.env` or
any real MongoDB connection string.
