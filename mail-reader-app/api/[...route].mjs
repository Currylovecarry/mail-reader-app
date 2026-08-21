import { handleCloudRequest } from "../cloud-server.mjs";

export default async function handler(request, response) {
  await handleCloudRequest(request, response);
}
