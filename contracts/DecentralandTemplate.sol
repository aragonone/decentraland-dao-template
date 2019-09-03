pragma solidity 0.4.24;

import "@aragon/templates-shared/contracts/BaseTemplate.sol";


contract DecentralandTemplate is BaseTemplate {

    constructor(DAOFactory _daoFactory, ENS _ens, MiniMeTokenFactory _miniMeFactory, IFIFSResolvingRegistrar _aragonID)
        BaseTemplate(_daoFactory, _ens, _miniMeFactory, _aragonID)
        public
    {
        _ensureAragonIdIsValid(_aragonID);
        _ensureMiniMeFactoryIsValid(_miniMeFactory);
    }

    function newInstance(string memory _id) public {
        // TODO: Uncomment when updated to @aragon/templates-shared 1.0.0-rc.2
        // _validateId(_id);

        (Kernel dao,) = _createDAO();

        _registerID(_id, dao);
    }
}
