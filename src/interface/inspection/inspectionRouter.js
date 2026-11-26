import { Router } from 'express';
import { Permissions } from '../../constants/appConstants.js';
import { requireAdmin, requirePermission } from '../../middlewares/roleMiddleware.js';
import { objectIdParamSchema } from '../../middlewares/validateMiddleware.js';
import { quickInspectSchema, rejectInspectionSchema } from '../../routes/inspectionSchemas.js';
import {
  draftPatch, emptyProposalAction, proposalCreateBody, proposalDraftBody, proposalListQuery,
  proposalReturnBody, submitBody, templateBody, templateKeyParams,
} from './inspectionSchemas.js';
import { inspectionResponse, result, sendInspectionError, verdictResponse } from './inspectionResponses.js';

// T023 adds the permission to the default role matrix when this router is mounted.
const SUBMIT_PERMISSION = 'inspection:submit';
const read = requirePermission(Permissions.INSPECTION_READ);
const write = requirePermission(Permissions.INSPECTION_WRITE);
const submit = requirePermission(SUBMIT_PERMISSION);
const admin = [requireAdmin, requirePermission(Permissions.INSPECTION_ADMIN)];

function validate(schema, property, options) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], { abortEarly: false, ...options });
    if (error) {
      const errors = error.details.map(({ path, type }) => ({
        field: type === 'object.unknown' ? path.slice(0, -1).join('.') || property : path.join('.') || property,
        message: type === 'object.unknown' ? 'Unsupported field.' : 'Invalid or missing value.',
      }));
      return sendInspectionError(res, { code: 'VALIDATION_ERROR', errors });
    }
    req[property] = value;
    return next();
  };
}

const byId = validate(objectIdParamSchema, 'params');
const byTemplateKey = validate(templateKeyParams, 'params');
const strictBody = (schema) => validate(schema, 'body', { convert: false, stripUnknown: false });
const compatibleBody = (schema) => validate(schema, 'body', { stripUnknown: true });

function actor(req) {
  return { id: req.userId, roleNames: req.userRoleNames, permissions: req.userPermissions };
}

function handle(run, { status = 200, message, project, conflictingCarStatus = false }) {
  const send = result(status, message, project);
  return async (req, res) => {
    try {
      return send(res, await run(req));
    } catch (error) {
      return sendInspectionError(res, error, { conflictingCarStatus });
    }
  };
}

/** Protected router. Mount once under /api/v1/inspections with the application's verifyToken. */
export function createInspectionRouter({ useCases, authenticate }) {
  const router = Router();
  router.use(authenticate);

  router.get('/form-templates/:templateKey', read, byTemplateKey, handle(
    (req) => useCases.getTemplate(req.params.templateKey),
    { message: 'Inspection form template retrieved.' },
  ));
  router.put('/form-templates/:templateKey', admin, byTemplateKey, strictBody(templateBody), handle(
    (req) => useCases.updateTemplate(req.params.templateKey, req.userId, req.body),
    { message: 'Inspection form template saved.' },
  ));

  const proposals = '/form-template-proposals';
  const proposalAccess = requirePermission(Permissions.INSPECTION_WRITE, Permissions.INSPECTION_ADMIN);
  router.get(proposals, proposalAccess, validate(proposalListQuery, 'query'), handle(
    (req) => useCases.listTemplateProposals(actor(req), req.query), { message: 'Template proposals retrieved.' },
  ));
  router.get(`${proposals}/:id`, proposalAccess, byId, handle(
    (req) => useCases.getTemplateProposal(req.params.id, actor(req)), { message: 'Template proposal retrieved.' },
  ));
  router.post(proposals, write, strictBody(proposalCreateBody), handle(
    (req) => useCases.createTemplateProposal(req.userId, req.body), { status: 201, message: 'Template proposal created.' },
  ));
  router.put(`${proposals}/:id`, write, byId, strictBody(proposalDraftBody), handle(
    (req) => useCases.updateTemplateProposal(req.params.id, req.userId, req.body), { message: 'Template proposal saved.' },
  ));
  router.post(`${proposals}/:id/submit`, write, byId, strictBody(emptyProposalAction), handle(
    (req) => useCases.submitTemplateProposal(req.params.id, req.userId), { message: 'Template proposal submitted.' },
  ));
  router.post(`${proposals}/:id/return`, admin, byId, strictBody(proposalReturnBody), handle(
    (req) => useCases.returnTemplateProposal(req.params.id, req.userId, req.body.reason), { message: 'Template proposal returned.' },
  ));
  router.post(`${proposals}/:id/approve`, admin, byId, strictBody(emptyProposalAction), handle(
    (req) => useCases.approveTemplateProposal(req.params.id, req.userId), { message: 'Template revision published.' },
  ));

  router.get('/cars/:id/current-certificate', read, byId, handle(
    (req) => useCases.getCurrentCertificate(req.params.id), { message: 'Current CPO certificate retrieved.' },
  ));
  router.post('/cars/:id/draft', write, byId, handle(
    (req) => useCases.createDraft(req.params.id, req.userId),
    { status: 201, message: 'Inspection draft created.', project: inspectionResponse },
  ));
  router.post('/cars/:id/inspect', write, byId, compatibleBody(quickInspectSchema), handle(
    (req) => useCases.inspectCar(req.params.id, actor(req), req.body),
    { message: 'Inspection evaluated and recorded successfully.', project: verdictResponse },
  ));
  router.post('/cars/:id/upload-signature', write, byId, handle(
    (req) => useCases.signQuickInspectionUpload(req.params.id, actor(req)),
    { message: 'Upload signature issued.' },
  ));
  router.put('/cars/:id/approve-sale', admin, byId, handle(
    (req) => useCases.approveSale(req.params.id),
    { message: 'Car approved for sale successfully.' },
  ));

  router.get('/:id', read, byId, handle(
    (req) => useCases.getInspection(req.params.id),
    { message: 'Inspection retrieved.', project: inspectionResponse },
  ));
  router.patch('/:id', write, byId, compatibleBody(draftPatch), handle(
    (req) => useCases.updateDraft(req.params.id, req.userId, req.body),
    { message: 'Inspection draft saved.', project: inspectionResponse },
  ));
  router.post('/:id/upload-signature', write, byId, handle(
    (req) => useCases.signInspectionUpload(req.params.id, actor(req)),
    { message: 'Upload signature issued.' },
  ));
  router.post('/:id/submit', submit, byId, strictBody(submitBody), handle(
    (req) => useCases.submitInspection(req.params.id, req.userId, req.body.baseRevision),
    { message: 'Inspection submitted for approval.', project: inspectionResponse, conflictingCarStatus: true },
  ));
  router.post('/:id/approve', admin, byId, handle(
    (req) => useCases.approveInspection(req.params.id, actor(req)),
    { message: 'Inspection approved.', project: verdictResponse, conflictingCarStatus: true },
  ));
  router.put('/:id/reject', admin, byId, compatibleBody(rejectInspectionSchema), handle(
    (req) => useCases.rejectInspection(req.params.id, req.userId, req.body.reason),
    { message: 'Inspection rejected and returned to draft.', project: inspectionResponse },
  ));

  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    return sendInspectionError(res, error);
  });
  return router;
}
