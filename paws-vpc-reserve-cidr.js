const utils = require('/opt/nodejs/utils');
const vpcUtils = require('/opt/nodejs/vpcUtils');
const configStatic = require('/opt/nodejs/configStatic');

/**
 * This method consolidates the reservation and formating of an CIDR object
 * @param {json} event  The Step Function Event obj
 * @param {json} context  The Step Function Context obj
 * @param {Object} siphonObj - The Siphon object
 * @param {string} cidrStatus - The CIDR status
 * @param {string} vpcStatus - The VPC Status
 * @returns {Promise<*>} returns a formated CIDR object
 */
async function createCidrObject(event, context, siphonObj, cidrStatus, vpcStatus, singleNatGatewayValue) {
  console.info('Did not find matching cidr so we need to reserve it');
  const reserveCidrBody = vpcUtils.getReserveCidrBody(event);
  console.info(`reserveCidrBody: ${JSON.stringify(reserveCidrBody, null, 2)}`);
  const siphonPathReserve = configStatic.siphonPaths.reserve;

  const siphonReserveResponse = await utils.makeBasicAuthRequest(
    'POST',
    siphonObj.siphonEndpoint,
    siphonPathReserve,
    reserveCidrBody,
    siphonObj.siphonUser,
    siphonObj.siphonPassword
  );
  console.info(`* Siphon Response: ${JSON.stringify(siphonReserveResponse, null, 2)}`);
  if (!siphonReserveResponse.cidr && !siphonReserveResponse.bam_id) {
    throw new Error(`Siphon Error: ${siphonReserveResponse.message}`);
  }
  const msg = `Reserved CIDR: ${siphonReserveResponse.cidr} bam_id: ${siphonReserveResponse.bam_id} ${siphonReserveResponse.account_name}/${siphonReserveResponse.region}`;
  await utils.sendToSlack(
    event,
    context.invokedFunctionArn,
    'info',
    'true',
    'false',
    msg,
    'false'
  );

  // eslint-disable-next-line no-return-await
  return await vpcUtils.formattedCidrReservedObject(siphonReserveResponse, cidrStatus, vpcStatus, singleNatGatewayValue);
}

/**
 * handler function to reserve CIDR block for VPC creation (currently use Siphon API)
 * @param {json} event  The Step Function Event obj
 * @param {json} context  The Step Function Context obj
 * @returns {Promise<*>} returns a complete CIDR object
 */
exports.handler = async function vpcReserveCIDR(event, context) {
  console.info(`event: ${JSON.stringify(event, null, 2)}`);

  const vpcStatus = 'new';
  const cidrStatus = 'initial';
  try {
    // TODO: JD 3/10/20 - fix the following so it accepts the SSL token properly
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;

    const { alias } = event;
    const siphonObj = {};
    siphonObj.siphonUser = await utils.getSecretValuePromisified(process.env.PAWS_SIPHON_USER);
    siphonObj.siphonPassword = await utils.getSecretValuePromisified(process.env.PAWS_SIPHON_PASSWORD);
    siphonObj.siphonEndpoint = configStatic.siphonEndpoint;
    siphonObj.siphonPathList = configStatic.siphonPaths.list;
    siphonObj.siphonEnv = vpcUtils.getSiphonEnv(event.accountType);
    // console.info(`siphonObj: ${JSON.stringify(siphonObj, null, 2)}`);

    console.info(`* URL: ${siphonObj.siphonEndpoint}${siphonObj.siphonPathList}`);
    const body = {
      account_name: alias
    };

    const siphonResponse = await utils.makeBasicAuthRequest(
      'POST',
      siphonObj.siphonEndpoint,
      siphonObj.siphonPathList,
      body,
      siphonObj.siphonUser,
      siphonObj.siphonPassword
    );
    // console.info(`siphonResponse: ${JSON.stringify(siphonResponse, null, 2)}`);

    const existingCidrObjects = vpcUtils.formatedCidrListArray(siphonResponse, 'existing');
    console.info(`Current Reserved CIDRs (${existingCidrObjects.length}): ${JSON.stringify(existingCidrObjects, null, 2)}`);

    let newCidrObj = {};
    let finalVpcObject;
    let singleNatGatewayValue;
    if (event.hasOwnProperty('vpcRegions')) {
      // * * If event.vpcRegions exists, then it is part of the new account create process.
      const vpcRegion = event.vpcRegions[0].region;
      console.info(`siphonEnv: ${siphonObj.siphonEnv}  -  vpcRegion: ${vpcRegion}`);

      if (event.vpcRegions[0].hasOwnProperty('singleNatGateway')) {
        singleNatGatewayValue = event.vpcRegions[0].singleNatGateway;
      }

      let matchingCidrObject = null;
      if (existingCidrObjects.length > 0) {
        // Now we'll create a check/function to see if any cidr objects match our env & region
        // eslint-disable-next-line no-restricted-syntax
        for (const evalCidrObject of existingCidrObjects) {
          if (siphonObj.siphonEnv === evalCidrObject.environment
              && vpcRegion === evalCidrObject.region) {
            console.info(` * * *  Matching ENV/Region (${siphonObj.siphonEnv}/${vpcRegion})  * * * `);
            console.info(`evalCidrObject: ${JSON.stringify(evalCidrObject, null, 2)}`);
            matchingCidrObject = evalCidrObject;
          }
        }
      }

      console.info(`matchingCidrObject (not null?): ${JSON.stringify(matchingCidrObject, null, 2)}`);
      if (matchingCidrObject !== null) {
        console.info('Found matching env & vpc region.  So we don\'t reserve a new cidr.  Need to pass this info to vpc-set-tfvars.');
        newCidrObj = matchingCidrObject;
      } else {
        newCidrObj = await createCidrObject(event, context, siphonObj, cidrStatus, vpcStatus, singleNatGatewayValue);
      }
    } else if (event.hasOwnProperty('vpc')) {
      // * * If event.vpc exists, then it is a single VPC add/update.
      console.info(`event.vpc: ${JSON.stringify(event.vpc, null, 2)}`);
      let siphonReserveResponse = {};
      if (event.vpc.hasOwnProperty('cidr')) {
        const vpcRegion = event.vpc.region;
        const vpcCidr = event.vpc.cidr;
        // If input includes a cidr field, we need to validate against the existing reservations to ensure that it matches.
        // Set vpcStatus to "update"
        if (existingCidrObjects.length > 0) {
          // Now we'll create a check/function to see if any cidr objects match passed in cidr
          console.info(`>> Check for existing: region/cidr ${vpcRegion}/${vpcCidr}`);
          // eslint-disable-next-line no-restricted-syntax
          for (const cidrObject of existingCidrObjects) {
            if (vpcRegion === cidrObject.region
                && vpcCidr === cidrObject.cidr) {
              cidrObject.vpcStatus = 'update';
              console.info(` * * *  Matching Region/CIDR (${vpcRegion}/${vpcCidr})  * * * `);
              console.info(`Matching CIDR Object: ${JSON.stringify(cidrObject, null, 2)}`);
              siphonReserveResponse = cidrObject;
            }
          }
        } else {
          // * Should be impossible to get here as the VPC event obj must have 'vpc' OR 'vpcRegions' key
          console.info('* * * HOW DID YOU GET HERE??  Event must have \'vpc\' OR \'vpcRegions\' key');
          console.info(`event: ${JSON.stringify(event, null, 2)}`);
        }
        if (utils.isObjectEmpty(siphonReserveResponse)) {
          // * Did not match any existing regions/cidr reservations we throw and error
          // * CIDR reservations are only allowed via PAWS and they only get the CIDR value once it is reserved.
          throw new Error(`INVALID CIDR RESERVATION: Input CIDR (${vpcCidr}) not found for ${alias} ${vpcRegion}`);
        } else {
          if (event.vpc.hasOwnProperty('singleNatGateway')) {
            singleNatGatewayValue = event.vpc.singleNatGateway;
          }

          newCidrObj = await vpcUtils.formattedCidrReservedObject(siphonReserveResponse, 'existing', 'update', singleNatGatewayValue);
        }
      } else {
        // No cidr provided so we assume this is an add of a single VPC.  Reserve cidr, format and add to event with vpcStatus of "add"
        if (event.vpc.hasOwnProperty('singleNatGateway')) {
          singleNatGatewayValue = event.vpc.singleNatGateway;
        }

        console.info(`event: ${JSON.stringify(event, null, 2)}`);
        newCidrObj = await createCidrObject(event, context, siphonObj, 'new', 'add', singleNatGatewayValue);
      }
    } else {
      console.info('ERROR: HOW DID YOU GET HERE??');
    }

    // eslint-disable-next-line prefer-const
    finalVpcObject = vpcUtils.addSubnets(newCidrObj);
    console.info(`finalVpcObject: ${JSON.stringify(finalVpcObject, null, 2)}`);

    return finalVpcObject;
  } catch (err) {
    console.info(`ERROR in handler.vpc-reserve-cidr():  ${JSON.stringify(err, null, 2)}`);

    // TODO: JD 5/20/20 - If we got here, did we reserve a CIDR that needs to be released??
    throw (err);
  }
};
